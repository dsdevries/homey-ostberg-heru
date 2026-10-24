import ModbusRTU from 'modbus-serial';
import BaseDevice from './base-device';
interface PendingWrite {
    startingAddress: number;
    // Settle the promise returned to the caller that queued the write
    resolve: () => void;
    reject: (err: Error) => void;
}

interface WriteModbusCoils extends PendingWrite {
    values: boolean[];
}

interface WriteModbusRegisters extends PendingWrite {
    values: number[];
}

// modbus-serial adds a modbusCode when the unit answers with an exception, e.g. for an unsupported register or an invalid value
function isModbusException(e: unknown): e is Error & { modbusCode: number } {
    return e instanceof Error && typeof (e as { modbusCode?: unknown }).modbusCode === 'number';
}

export class HeruAPI {
    device?: BaseDevice;
    client: ModbusRTU;

    isConnected = false;
    consecutiveFailedRead = 0;
    consecutiveFailedWrite = 0;
    MAX_WRITE_ATTEMPTS = 5;
    reconnectCounter = 0;
    POLLING_INTERVAL = 2000;
    timer: NodeJS.Timeout | null = null;
    ignoreNextRead = false; // Used to prevent reading modbus straight after a command to avoid timing issues
    write = false;
    writeQueue = {
        coils: [],
        holdingRegisters: []
    } as { coils: WriteModbusCoils[]; holdingRegisters: WriteModbusRegisters[] }; //new Map<'coils' | 'holdingRegisters', WriteModbusRegisters[] | WriteModbusCoils[]>();

    registers: ModbusRegisters = {
        coils: {
            start: 0,
            count: 0
        },
        discreteInputs: {
            start: 0,
            count: 0
        },
        inputRegisters: {
            start: 0,
            count: 0
        },
        holdingRegisters: {
            start: 0,
            count: 0
        }
    };

    constructor(device: BaseDevice, registers: ModbusRegisters, interval: number) {
        this.POLLING_INTERVAL = interval;
        this.device = device;
        this.registers = registers;
        this.client = new ModbusRTU();
        // this.client.setTimeout(800); // Milliseconds
        this.client.setID(1);
        this.timer = setTimeout(() => {
            this.pollVentilationSystem();
        }, this.POLLING_INTERVAL);
        this.connect(this.device?.getSetting('ip'), this.device?.getSetting('port'), !!this.device?.getSetting('tcp'));
    }

    connect(ip: string, port: number, tcpConnection = false) {
        if (tcpConnection) {
            this.client
                .connectTCP(ip, { port })
                .then(() => this.onConnected())
                .catch((err) => this.onFailedToConnect(err));
        } else {
            this.client
                .connectTelnet(ip, { port })
                .then(() => this.onConnected())
                .catch((err) => this.onFailedToConnect(err));
        }
    }

    onConnected() {
        this.isConnected = true;
        this.device?.log(`Connected to ${this.device?.getSettings().ip}:${this.device?.getSettings().port}`);
    }

    onFailedToConnect(err: string) {
        this.isConnected = false;
        this.device?.log(`Unable to connect to ${this.device?.getSettings().ip}:${this.device?.getSettings().port} --> ${err}`);
        this.device?.setUnavailable(`Unable to connect to ${this.device?.getSettings().ip}:${this.device?.getSettings().port}`).catch((err) => this.device?.error(`Failed to set unavailable: ${err}`));
    }

    reconnect(ip: string, port: number, tcpConnection = false) {
        this.reconnectCounter = 0;
        this.client.close(() => {
            this.device?.log('Reconnecting...');
        });
        this.connect(ip, port, tcpConnection);
    }

    checkConnection() {
        if (this.reconnectCounter > 5) {
            this.reconnect(this.device?.getSetting('ip'), this.device?.getSetting('port'), !!this.device?.getSetting('tcp'));
        } else {
            this.reconnectCounter++;
        }
    }

    async writeModbus() {
        try {
            await this.processWriteQueue(this.writeQueue.coils, 'coils', (coil) => this.client.writeCoils(coil.startingAddress, coil.values));
            await this.processWriteQueue(this.writeQueue.holdingRegisters, 'registers', (register) => this.client.writeRegisters(register.startingAddress, register.values));
            this.consecutiveFailedWrite = 0;
        } catch (e) {
            // Only connection problems end up here, so retry the remaining writes on the next poll
            this.consecutiveFailedWrite++;
            this.device?.error(`Failed to write to client (attempt ${this.consecutiveFailedWrite}/${this.MAX_WRITE_ATTEMPTS})`, e);
            if (this.consecutiveFailedWrite >= this.MAX_WRITE_ATTEMPTS) {
                this.device?.error('Giving up on pending writes, clearing write queue', this.writeQueue);
                this.rejectPendingWrites(`Could not write to the unit: ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    async processWriteQueue<T extends WriteModbusCoils | WriteModbusRegisters>(queue: T[], type: string, write: (pendingWrite: T) => Promise<unknown>) {
        // Remove each item only after it was handled, so a retry doesn't repeat writes that already succeeded
        while (queue.length) {
            const pendingWrite = queue[0];
            try {
                await write(pendingWrite);
            } catch (e) {
                if (!isModbusException(e)) throw e;
                // The unit answered but refused this write, so retrying won't help. Fail only this write and carry on with the rest.
                this.device?.error(`The unit rejected the write to ${type} starting at`, pendingWrite.startingAddress, '-->', pendingWrite.values, e.message);
                queue.shift();
                pendingWrite.reject(new Error(`The unit rejected the new value: ${e.message}`));
                continue;
            }
            this.device?.log(`Successfully wrote to ${type} starting at `, pendingWrite.startingAddress, ' --> ', pendingWrite.values);
            queue.shift();
            pendingWrite.resolve();
        }
    }

    rejectPendingWrites(message: string) {
        // Empty the queues in place, as processWriteQueue may still hold a reference to them
        const pendingWrites = [...this.writeQueue.coils.splice(0), ...this.writeQueue.holdingRegisters.splice(0)];
        this.consecutiveFailedWrite = 0;
        pendingWrites.forEach((pendingWrite) => pendingWrite.reject(new Error(message)));
    }

    hasPendingWriteRequests() {
        return this.writeQueue.coils.length || this.writeQueue.holdingRegisters.length;
    }

    async pollVentilationSystem() {
        try {
            this.checkConnection();
            if (this.isConnected) {
                if (this.hasPendingWriteRequests()) {
                    this.ignoreNextRead = true;
                    this.device?.log('Processing write queue, going to ignore next read');
                    await this.writeModbus();
                } else {
                    if (!this.ignoreNextRead) {
                        try {
                            const results = await this.readRegisters(this.client);
                            this.reconnectCounter = 0;
                            this.consecutiveFailedRead = 0;
                            this.device?.setAvailable().catch((e) => this.device?.error(`Failed to set available: ${e}`));
                            if (!this.ignoreNextRead) this.device?.processResults(results);
                            else this.device?.log('Ignored read results');
                        } catch (err) {
                            if (this.consecutiveFailedRead < 2) {
                                this.consecutiveFailedRead++;
                            } else {
                                this.device
                                    ?.setUnavailable(`Connected to ${this.device?.getSetting('ip')}:${this.device.getSetting('port')}, but got error: "${err}"`)
                                    .catch((e) => this.device?.error(`Failed to set unavailable: ${e}`));
                            }
                            this.device?.error(err);
                        }
                    } else this.device?.log('Ignored read');
                    this.ignoreNextRead = false;
                }
            } else if (this.hasPendingWriteRequests()) {
                this.rejectPendingWrites('Not connected to the unit');
            }
        } catch (err) {
            this.device?.error('Polling failed', err);
        } finally {
            this.timer = setTimeout(() => {
                this.pollVentilationSystem();
            }, this.POLLING_INTERVAL);
        }
    }

    async readRegisters(client: InstanceType<typeof ModbusRTU>) {
        return new Promise<{ coils: boolean[]; discreteInputs: boolean[]; inputRegisters: number[]; holdingRegisters: number[] }>(async (resolve, reject) => {
            const result = {
                coils: [],
                discreteInputs: [],
                inputRegisters: [],
                holdingRegisters: []
            } as { coils: boolean[]; discreteInputs: boolean[]; holdingRegisters: number[]; inputRegisters: number[] };
            let coilStatus;
            let inputRegisters;
            let holdingRegisters;
            let discreteInputs;

            const timeout = setTimeout(() => {
                reject('Modbus timeout');
            }, Math.floor(this.POLLING_INTERVAL / 2));
            try {
                coilStatus = await client.readCoils(this.registers.coils.start, this.registers.coils.count);
                discreteInputs = await client.readDiscreteInputs(this.registers.discreteInputs.start, this.registers.discreteInputs.count);
                inputRegisters = await client.readInputRegisters(this.registers.inputRegisters.start, this.registers.inputRegisters.count);
                holdingRegisters = await client.readHoldingRegisters(this.registers.holdingRegisters.start, this.registers.holdingRegisters.count);
            } catch (err: any) {
                clearTimeout(timeout);
                reject(err?.message || 'Modbus timeout');
            }

            if (coilStatus) {
                result.coils = coilStatus.data;
            }
            if (discreteInputs) {
                result.discreteInputs = discreteInputs.data;
            }
            if (inputRegisters) {
                result.inputRegisters = inputRegisters.data;
            }
            if (holdingRegisters) {
                result.holdingRegisters = holdingRegisters.data;
            }
            clearTimeout(timeout);
            resolve(result);
        });
    }

    // The returned promise resolves once the value is written to the unit, and rejects if the write is dropped
    writeRegister(startRegister: number, value: number): Promise<void> {
        if (!this.isConnected) return Promise.reject(new Error('Not connected to the unit'));
        this.ignoreNextRead = true;
        this.device?.log('Adding registers starting at: ', startRegister, '-->', value, 'to write queue');
        return new Promise((resolve, reject) => {
            this.writeQueue['holdingRegisters'].push({ values: [value], startingAddress: startRegister, resolve, reject });
        });
    }

    // The returned promise resolves once the values are written to the unit, and rejects if the write is dropped
    writeMultipleCoils(startCoil: number, values: boolean[]): Promise<void> {
        if (!this.isConnected) return Promise.reject(new Error('Not connected to the unit'));
        this.ignoreNextRead = true;
        this.device?.log('Adding coils starting at: ', startCoil, '-->', values, 'to write queue');
        return new Promise((resolve, reject) => {
            this.writeQueue['coils'].push({ values, startingAddress: startCoil, resolve, reject });
        });
    }

    writeCoil(coil: number, value: boolean): Promise<void> {
        return this.writeMultipleCoils(coil, [value]);
    }

    destroy() {
        this.rejectPendingWrites('The device was removed');
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.client?.close(() => {
            this.device?.log('Destroyed. Closing connection to client.');
        });
    }

    setPollingInterval(interval: number) {
        this.device?.log(`Polling interval set to: ${interval}ms`);
        this.POLLING_INTERVAL = interval;
    }
}
