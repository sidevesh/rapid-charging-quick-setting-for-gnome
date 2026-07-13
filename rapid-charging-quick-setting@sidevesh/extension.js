import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const POWER_SUPPLY_DIR = '/sys/class/power_supply';
const CHARGE_TYPES_ATTR = 'charge_types';
const CHARGE_CONTROL_START_THRESHOLD_ATTR = 'charge_control_start_threshold';
const CHARGE_CONTROL_END_THRESHOLD_ATTR = 'charge_control_end_threshold';
const FAST_CHARGE_TYPE = 'Fast';
const STANDARD_CHARGE_TYPE = 'Standard';
const POLL_INTERVAL_SECONDS = 5;

// Used only to keep UPower's own ChargeThresholdEnabled property truthful when
// we write charge_types directly (see _setupUPowerSync). UPower has no concept
// of "Fast" -- EnableChargeThreshold(bool) only distinguishes Long_Life
// (enabled) from "whatever charge type UPower itself picks" (disabled), so we
// can't delegate the actual Fast/Standard write to it. We only ever call it
// with `false`, to correct its cached state after it goes stale relative to
// a charge_types change we made ourselves; the real write below is what
// actually sets Fast or Standard.
const UPowerIface = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg name="devices" type="ao" direction="out"/>
    </method>
  </interface>
</node>`;

const UPowerDeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="NativePath" type="s" access="read"/>
    <property name="ChargeThresholdSupported" type="b" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>

    <method name="EnableChargeThreshold">
      <arg name="enabled" type="b" direction="in"/>
    </method>
  </interface>
</node>`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceIface);

const RapidChargingToggle = GObject.registerClass(
class RapidChargingToggle extends QuickSettings.QuickToggle {
    _init() {
        super._init({
            title: 'Rapid Charging',
            iconName: 'battery-full-charging-symbolic',
            toggleMode: true,
        });

        this._chargeTypesPath = null;
        this._deviceNativePath = null;
        this._upowerSyncNeeded = false;
        this._upowerDeviceProxy = null;
        this._cancellable = new Gio.Cancellable();
        this._pollSourceId = null;

        this.connect('clicked', () => this._toggleRapidCharge());

        this._findChargeTypesFile();
        this._pollSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });

        if (this._upowerSyncNeeded)
            this._setupUPowerSync();
    }

    // Looks for a power_supply device exposing a charge_types attribute
    // that lists "Fast" (Rapid Charge) as one of its options.
    _findChargeTypesFile() {
        this._chargeTypesPath = null;

        try {
            const dir = Gio.File.new_for_path(POWER_SUPPLY_DIR);
            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);

            let info;
            while ((info = enumerator.next_file(null))) {
                const deviceName = info.get_name();
                const devicePath = GLib.build_filenamev([POWER_SUPPLY_DIR, deviceName]);
                const path = GLib.build_filenamev([devicePath, CHARGE_TYPES_ATTR]);
                const contents = this._readFile(path);
                if (contents !== null && contents.includes(FAST_CHARGE_TYPE)) {
                    this._chargeTypesPath = path;
                    this._deviceNativePath = deviceName;
                    // Only worth reconciling with UPower on devices where the
                    // charge threshold is controlled through this same
                    // charge_types attribute rather than real
                    // charge_control_start/end_threshold attributes -- see
                    // up_device_supply_battery_is_charge_threshold_by_charge_type()
                    // in upower's src/linux/up-device-supply-battery.c. On real
                    // threshold hardware, UPower's EnableChargeThreshold would
                    // touch charge_control_*_threshold instead, which we must
                    // never do from here.
                    this._upowerSyncNeeded =
                        !GLib.file_test(GLib.build_filenamev([devicePath, CHARGE_CONTROL_START_THRESHOLD_ATTR]), GLib.FileTest.EXISTS) &&
                        !GLib.file_test(GLib.build_filenamev([devicePath, CHARGE_CONTROL_END_THRESHOLD_ATTR]), GLib.FileTest.EXISTS);
                    break;
                }
            }
            enumerator.close(null);
        } catch (e) {
            console.log('Failed to look for a rapid-charge-capable battery:', e);
        }

        this._sync();
    }

    // Finds the UPower device object matching our battery, so we can correct
    // its cached ChargeThresholdEnabled property when we change charge_types
    // out from under it (UPower only updates that property from its own
    // writes or at battery-plug time, never by re-reading live charge_types --
    // see up_device_battery_update_info() in upower's src/up-device-battery.c).
    // Failure here is non-fatal: it just means we skip the UPower sync step
    // and behave exactly as before.
    async _setupUPowerSync() {
        try {
            const upowerProxy = await new Promise((resolve, reject) => {
                new UPowerProxy(
                    Gio.DBus.system,
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower',
                    (proxy, error) => error ? reject(error) : resolve(proxy),
                    this._cancellable
                );
            });

            const [devicePaths] = await upowerProxy.EnumerateDevicesAsync();
            for (const devicePath of devicePaths) {
                const deviceProxy = await new Promise((resolve, reject) => {
                    new UPowerDeviceProxy(
                        Gio.DBus.system,
                        'org.freedesktop.UPower',
                        devicePath,
                        (proxy, error) => error ? reject(error) : resolve(proxy),
                        this._cancellable
                    );
                });

                // UP_DEVICE_KIND_BATTERY is 2
                if (deviceProxy.Type === 2 && deviceProxy.PowerSupply &&
                    deviceProxy.ChargeThresholdSupported && deviceProxy.NativePath === this._deviceNativePath) {
                    this._upowerDeviceProxy = deviceProxy;
                    break;
                }
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.log('Failed to set up UPower sync (Preserve Battery toggle may show stale state):', e);
        }
    }

    _readFile(path) {
        try {
            const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
            return ok ? new TextDecoder().decode(contents).trim() : null;
        } catch (e) {
            return null;
        }
    }

    _sync() {
        if (!this._chargeTypesPath) {
            this.visible = false;
            return;
        }

        const contents = this._readFile(this._chargeTypesPath);
        if (contents === null) {
            this.visible = false;
            return;
        }

        this.visible = true;
        this.checked = contents.includes(`[${FAST_CHARGE_TYPE}]`);
    }

    async _toggleRapidCharge() {
        if (!this._chargeTypesPath)
            return;

        const desiredType = this.checked ? FAST_CHARGE_TYPE : STANDARD_CHARGE_TYPE;

        // Neither Fast nor Standard is Long_Life, so either way we're about to
        // move this device away from what UPower would call "charge threshold
        // enabled". If UPower still thinks it's enabled, tell it otherwise
        // first so its cached property/state file don't go stale -- see the
        // comment on _setupUPowerSync above for why this can't just be an
        // EnableChargeThreshold(true) call for Fast instead of a direct write.
        if (this._upowerDeviceProxy?.ChargeThresholdEnabled) {
            try {
                await this._upowerDeviceProxy.EnableChargeThresholdAsync(false);
            } catch (e) {
                console.log('Failed to sync UPower charge threshold state:', e);
            }
        }

        try {
            const bytes = new TextEncoder().encode(desiredType);
            Gio.File.new_for_path(this._chargeTypesPath)
                .replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            console.log('Failed to set charge type (see README for the required udev rule):', e);
        }

        this._sync();
    }

    destroy() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }

        this._cancellable.cancel();

        super.destroy();
    }
});

const RapidChargingIndicator = GObject.registerClass(
class RapidChargingIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._toggle = new RapidChargingToggle();
        this.quickSettingsItems.push(this._toggle);
    }
});

export default class RapidChargingExtension extends Extension {
    enable() {
        if (this._indicator) return;
        this._indicator = new RapidChargingIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
