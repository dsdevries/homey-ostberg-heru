import BaseDevice from '../base-device';
import { HeruAPI } from '../heru-api';
import { Gen3HoldingRegisters, Gen3Registers } from '../registers';
import { alarms, registers, RegulationModeGen3, SetRegulationModeGen3 } from './constants';
import { convertArrayOfBooleansToNumber, convertNumberToArrayOfBooleans } from './utils';

export class Gen3Remote extends BaseDevice {
    async onInit() {
        super.onInit();
        await this.upgradeExistingDevice();
        this.api = new HeruAPI(this, registers, this.getSetting('interval') || 2000);
        this.log(`${this.getName()} has been initialized`);

        this.registerCapabilityListener('regulation_mode_gen3', async (value: SetRegulationModeGen3) => {
            await this.setRegulationMode(value);
            this.triggerRegulationModeChanged(value);
        });

        this.registerCapabilityListener('target_temperature', async (value) => {
            await this.setTargetTemperature(value);
        });

        this.registerCapabilityListener('heater_enabled_gen3', async (value) => {
            await this.setHeaterEnabled(value);
        });

        this.registerCapabilityListener('week_timer_enabled_gen3', async (value) => {
            await this.setWeekTimerEnabled(value);
        });
        this.registerCapabilityListener('summer_night_cooling_enabled', async (value) => {
            await this.setSummerNightCoolingEnabled(value);
        });
    }

    async upgradeExistingDevice() {
        if (!this.hasCapability('heater_enabled_gen3')) await this.addCapability('heater_enabled_gen3');
        if (!this.hasCapability('week_timer_enabled_gen3')) await this.addCapability('week_timer_enabled_gen3');
        if (!this.hasCapability('week_timer_current_active_program_gen3')) await this.addCapability('week_timer_current_active_program_gen3');
        if (!this.hasCapability('summer_night_cooling_enabled')) await this.addCapability('summer_night_cooling_enabled');
        if (!this.hasCapability('meter_thermal_efficiency')) await this.addCapability('meter_thermal_efficiency');
    }

    async setHeaterEnabled(value: boolean) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters.HEATER_ENABLED, value ? 1 : 0);
    }

    async setSummerNightCoolingEnabled(value: boolean) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters.SUMMER_NIGHT_COOLING_ENABLED, value ? 1 : 0);
    }

    async setWeekTimerEnabled(value: boolean) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters.WEEK_TIMER_ENABLED, value ? 1 : 0);
    }

    async updateWeekProgramWeekdays(program: number, weekdays: number) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_WEEKDAYS` as keyof typeof Gen3HoldingRegisters], weekdays);
    }

    async updateWeekProgramStartTime(program: number, hour: number, minute: number) {
        await Promise.all([
            this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_START_HOUR` as keyof typeof Gen3HoldingRegisters], hour),
            this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_START_MINUTE` as keyof typeof Gen3HoldingRegisters], minute)
        ]);
    }

    async updateWeekProgramEndTime(program: number, hour: number, minute: number) {
        await Promise.all([
            this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_END_HOUR` as keyof typeof Gen3HoldingRegisters], hour),
            this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_END_MINUTE` as keyof typeof Gen3HoldingRegisters], minute)
        ]);
    }

    async updateWeekProgramTemperature(program: number, temperature: number) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_TEMPERATURE` as keyof typeof Gen3HoldingRegisters], temperature);
    }

    async updateWeekProgramFanSpeed(program: number, fanSpeed: number) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_FAN_SPEED` as keyof typeof Gen3HoldingRegisters], fanSpeed);
    }

    async setTargetTemperature(target: number) {
        await this.api?.writeRegister(Gen3Registers.holdingRegisters.SETPOINT_TEMPERATURE, target);
    }

    async onAdded() {
        this.log('Gen 3 Remote device has been added with the following settings: ', this.getSettings());
    }

    async onDeleted() {
        super.onDeleted();
        this.log(`Gen3Remote device ${this.getName()} deleted`);
    }

    triggerRegulationModeChanged(value: SetRegulationModeGen3) {
        let mode = 'Unknown';
        switch (value) {
            case SetRegulationModeGen3.SUPPLY:
                mode = 'Supply air';
                break;
            case SetRegulationModeGen3.EXTRACT:
                mode = 'Extract air';
                break;
            case SetRegulationModeGen3.ROOM:
                mode = 'Room';
                break;
        }
        this.homey.flow.getDeviceTriggerCard('regulation_mode_changed_gen3').trigger(this, { mode }).catch(this.error);
    }

    isRegulationMode(value: SetRegulationModeGen3) {
        return this.getCapabilityValue('regulation_mode_gen3') === value;
    }

    async setRegulationMode(value: SetRegulationModeGen3) {
        switch (value) {
            case SetRegulationModeGen3.SUPPLY:
                await this.api?.writeRegister(Gen3Registers.holdingRegisters.REGULATION_MODE, RegulationModeGen3.SUPPLY);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_supply_air')).catch(this.error);
                break;
            case SetRegulationModeGen3.EXTRACT:
                await this.api?.writeRegister(Gen3Registers.holdingRegisters.REGULATION_MODE, RegulationModeGen3.EXTRACT);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_extract_air')).catch(this.error);
                break;
            case SetRegulationModeGen3.ROOM:
                await this.api?.writeRegister(Gen3Registers.holdingRegisters.REGULATION_MODE, RegulationModeGen3.ROOM);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_room')).catch(this.error);
                break;
        }
    }

    async processRegulationMode(regulationMode: RegulationModeGen3, targetTemperature: number) {
        const previousRegulationMode = this.getCapabilityValue('regulation_mode_gen3');
        switch (regulationMode) {
            case RegulationModeGen3.SUPPLY:
                await this.setCapabilityValue('regulation_mode_gen3', SetRegulationModeGen3.SUPPLY).catch(this.error);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_supply_air')).catch(this.error);
                break;
            case RegulationModeGen3.EXTRACT:
                await this.setCapabilityValue('regulation_mode_gen3', SetRegulationModeGen3.EXTRACT).catch(this.error);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_extract_air')).catch(this.error);
                break;
            case RegulationModeGen3.ROOM:
                await this.setCapabilityValue('regulation_mode_gen3', SetRegulationModeGen3.ROOM).catch(this.error);
                this.setCapabilityValue('measure_temperature', this.getCapabilityValue('meter_temperature_room')).catch(this.error);
                break;
        }
        this.setCapabilityValue('target_temperature', targetTemperature).catch(this.error);
        const newRegulationMode: SetRegulationModeGen3 = this.getCapabilityValue('regulation_mode_gen3');
        if (previousRegulationMode !== newRegulationMode) this.triggerRegulationModeChanged(newRegulationMode);
    }

    async processAlarms(discreteInputs: boolean[]): Promise<void> {
        const previousAlarms: { [index: string]: boolean } = this.getStoreValue('alarms') || {};
        const currentAlarms: { [index: string]: boolean } = {} as { [index: string]: boolean };
        currentAlarms['fire_alarm'] = discreteInputs[Gen3Registers.discreteInputs.FIRE_ALARM];
        currentAlarms['rotor_alarm'] = discreteInputs[Gen3Registers.discreteInputs.ROTOR_ALARM];
        currentAlarms['freeze_alarm'] = discreteInputs[Gen3Registers.discreteInputs.FREEZE_ALARM];
        currentAlarms['low_supply_alarm'] = discreteInputs[Gen3Registers.discreteInputs.LOW_SUPPLY_ALARM];
        currentAlarms['low_rotor_temperature_alarm'] = discreteInputs[Gen3Registers.discreteInputs.LOW_ROTOR_TEMPEARTURE_ALARM];
        currentAlarms['temp_sensor_open_circuit_alarm'] = discreteInputs[Gen3Registers.discreteInputs.TEMP_SENSOR_OPEN_CIRCUIT_ALARM];
        currentAlarms['temp_sensor_short_circut_alarm'] = discreteInputs[Gen3Registers.discreteInputs.TEMP_SENSOR_SHORT_CIRCUIT_ALARM];
        currentAlarms['pulser_alarm'] = discreteInputs[Gen3Registers.discreteInputs.PULSER_ALARM];
        currentAlarms['supply_fan_alarm'] = discreteInputs[Gen3Registers.discreteInputs.SUPPLY_FAN_ALARM];
        currentAlarms['extract_fan_alarm'] = discreteInputs[Gen3Registers.discreteInputs.EXHAUST_FAN_ALARM];
        currentAlarms['supply_filter_alarm'] = discreteInputs[Gen3Registers.discreteInputs.SUPPLY_FILTER_ALARM];
        currentAlarms['extract_filter_alarm'] = discreteInputs[Gen3Registers.discreteInputs.EXHAUST_FILTER_ALARM];
        currentAlarms['filter_timer_alarm'] = discreteInputs[Gen3Registers.discreteInputs.FILTER_TIMER_ALARM];
        currentAlarms['carbondioxide_boost_alarm'] = discreteInputs[Gen3Registers.discreteInputs.CO2_BOOST];
        const activeAlarms = await this.checkAlarmTriggers(currentAlarms, previousAlarms, alarms);
        if (this.hasCapability('alarm_active_alarms')) {
            this.setCapabilityValue('alarm_active_alarms', !!activeAlarms.length).catch((err) => this.error(err));
        }
    }

    listActiveAlarms() {
        const currentAlarms = this.getStoreValue('alarms');
        return {
            allActive: this.getActiveAlarmsString(currentAlarms, alarms)
        };
    }

    async onSettings(event: {
        oldSettings: { [p: string]: any };
        newSettings: { [p: string]: any };
        changedKeys: string[]
    }): Promise<string | void> {
        await super.onSettings(event);

        const { changedKeys, newSettings } = event;

        // Wait for the unit to accept the new values, so a failed write shows an error and the settings are not saved
        const writes = [1, 2, 3, 4, 5].flatMap((program) => {
            const prefix = `program_${program}`;
            const setting = (key: string) => newSettings[`${prefix}_${key}`];
            const updates: [string, () => Promise<void>][] = [
                ['week_day', () => this.updateWeekProgramWeekdays(
                    program,
                    convertArrayOfBooleansToNumber(['sunday', 'saturday', 'friday', 'thursday', 'wednesday', 'tuesday', 'monday'].map((day) => setting(`week_day_${day}`)))
                )],
                ['start', () => this.updateWeekProgramStartTime(program, setting('start_hour'), setting('start_minute'))],
                ['end', () => this.updateWeekProgramEndTime(program, setting('end_hour'), setting('end_minute'))],
                ['temperature', () => this.updateWeekProgramTemperature(program, setting('temperature'))],
                ['fan_speed', () => this.updateWeekProgramFanSpeed(program, setting('fan_speed'))]
            ];

            return updates
                .filter(([key]) => changedKeys.some((changedKey) => changedKey.includes(`${prefix}_${key}`)))
                .map(([, update]) => update());
        });
        await Promise.all(writes);
    }

    processResults(results: { coils: boolean[]; discreteInputs: boolean[]; inputRegisters: number[]; holdingRegisters: number[] }): void {
        super.processResults(results);

        // Inputs Registers
        if (results.inputRegisters.length) {
            if (this.hasCapability('measure_co2')) {
                this.setCapabilityValue('measure_co2', results.inputRegisters[Gen3Registers.inputRegisters.CARBON_DIOXIDE]).catch(this.error);
                this.setCapabilityValue('week_timer_current_active_program_gen3', results.inputRegisters[Gen3Registers.inputRegisters.WEEK_TIMER_CURRENT_ACTIVE_PROGRAM].toString(10)).catch(this.error);
            }
        }

        // Holding Registers
        if (results.holdingRegisters.length) {
            const programSettings = Array.from({ length: 5 }).map((_, i) => {
                const program = i + 1;
                const weekdays = convertNumberToArrayOfBooleans(results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_WEEKDAYS` as keyof typeof Gen3HoldingRegisters]], 7);

                return {
                    [`program_${program}_week_day_monday`]: weekdays[6],
                    [`program_${program}_week_day_tuesday`]: weekdays[5],
                    [`program_${program}_week_day_wednesday`]: weekdays[4],
                    [`program_${program}_week_day_thursday`]: weekdays[3],
                    [`program_${program}_week_day_friday`]: weekdays[2],
                    [`program_${program}_week_day_saturday`]: weekdays[1],
                    [`program_${program}_week_day_sunday`]: weekdays[0],
                    [`program_${program}_start_hour`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_START_HOUR` as keyof typeof Gen3HoldingRegisters]],
                    [`program_${program}_start_minute`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_START_MINUTE` as keyof typeof Gen3HoldingRegisters]],
                    [`program_${program}_end_hour`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_END_HOUR` as keyof typeof Gen3HoldingRegisters]],
                    [`program_${program}_end_minute`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_END_MINUTE` as keyof typeof Gen3HoldingRegisters]],
                    [`program_${program}_temperature`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_TEMPERATURE` as keyof typeof Gen3HoldingRegisters]],
                    [`program_${program}_fan_speed`]: results.holdingRegisters[Gen3Registers.holdingRegisters[`WEEK_TIMER_PROGRAM_${program}_FAN_SPEED` as keyof typeof Gen3HoldingRegisters]].toString(10)
                }
            }).reduce((acc, current) => {
                return Object.assign(acc, current);
            }, {})

            const currentSettings = this.getSettings();
            const programSettingsChanged = Object.keys(programSettings).some((k) => currentSettings[k] !== programSettings[k]);
            if (programSettingsChanged) this.setSettings(programSettings).catch(this.error);

            this.setCapabilityValue('heater_enabled_gen3', !!results.holdingRegisters[Gen3Registers.holdingRegisters.HEATER_ENABLED]).catch(this.error);
            this.setCapabilityValue('summer_night_cooling_enabled', !!results.holdingRegisters[Gen3Registers.holdingRegisters.SUMMER_NIGHT_COOLING_ENABLED]).catch(this.error);
            this.setCapabilityValue('week_timer_enabled_gen3', !!results.holdingRegisters[Gen3Registers.holdingRegisters.WEEK_TIMER_ENABLED]).catch(this.error);

        }

    }
}

module.exports = Gen3Remote;
