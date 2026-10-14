import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const POWER_SUPPLY_DIR = '/sys/class/power_supply';
const CHARGE_TYPES_ATTR = 'charge_types';
const CHARGE_CONTROL_START_THRESHOLD_ATTR = 'charge_control_start_threshold';
const CHARGE_CONTROL_END_THRESHOLD_ATTR = 'charge_control_end_threshold';
const FAST_CHARGE_TYPE = 'Fast';
const STANDARD_CHARGE_TYPE = 'Standard';
// The kernel emits no change notification for charge_types, so it has to be polled.
const POLL_INTERVAL_SECONDS = 5;
const UP_DEVICE_KIND_BATTERY = 2;

// UPower has no notion of "Fast", so charge_types is written directly. UPower is
// only used to clear its cached ChargeThresholdEnabled, which goes stale when
// charge_types changes underneath it.
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

function logError(message, e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.error(message, e);
}

function createProxy(ProxyClass, objectPath, cancellable) {
    return new Promise((resolve, reject) => {
        new ProxyClass(
            Gio.DBus.system,
            'org.freedesktop.UPower',
            objectPath,
            (proxy, error) => error ? reject(error) : resolve(proxy),
            cancellable
        );
    });
}

const RapidChargingToggle = GObject.registerClass(
class RapidChargingToggle extends QuickSettings.QuickToggle {
    _init() {
        super._init({
            title: 'Rapid Charging',
            iconName: 'battery-full-charging-symbolic',
            toggleMode: true,
            visible: false,
        });

        this._chargeTypesPath = null;
        this._deviceNativePath = null;
        this._upowerDeviceProxy = null;
        this._cancellable = new Gio.Cancellable();

        this.connect('clicked', () => {
            this._toggleRapidCharge().catch(e => logError('Failed to set charge type:', e));
        });

        this._setup().catch(e => logError('Failed to set up Rapid Charging:', e));

        this._pollSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this._sync().catch(e => logError('Failed to read charge type:', e));
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _setup() {
        const upowerSyncNeeded = await this._findChargeTypesFile();
        await this._sync();

        if (upowerSyncNeeded)
            await this._setupUPowerSync();
    }

    // Returns whether UPower should be kept in sync, which is only the case when
    // charge_types also acts as the charge threshold (no charge_control_*_threshold
    // attributes). Otherwise UPower's EnableChargeThreshold writes those attributes,
    // which must never happen from here.
    async _findChargeTypesFile() {
        const dir = Gio.File.new_for_path(POWER_SUPPLY_DIR);
        const enumerator = await dir.enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);

        for await (const info of enumerator) {
            const deviceName = info.get_name();
            const devicePath = GLib.build_filenamev([POWER_SUPPLY_DIR, deviceName]);
            const contents = await this._readFile(GLib.build_filenamev([devicePath, CHARGE_TYPES_ATTR]));
            if (!contents?.includes(FAST_CHARGE_TYPE))
                continue;

            this._chargeTypesPath = GLib.build_filenamev([devicePath, CHARGE_TYPES_ATTR]);
            this._deviceNativePath = deviceName;

            const startThreshold = await this._readFile(GLib.build_filenamev([devicePath, CHARGE_CONTROL_START_THRESHOLD_ATTR]));
            const endThreshold = await this._readFile(GLib.build_filenamev([devicePath, CHARGE_CONTROL_END_THRESHOLD_ATTR]));
            return startThreshold === null && endThreshold === null;
        }

        return false;
    }

    async _setupUPowerSync() {
        const upowerProxy = await createProxy(UPowerProxy, '/org/freedesktop/UPower', this._cancellable);
        const [devicePaths] = await upowerProxy.EnumerateDevicesAsync();

        for (const devicePath of devicePaths) {
            const deviceProxy = await createProxy(UPowerDeviceProxy, devicePath, this._cancellable);
            if (deviceProxy.Type === UP_DEVICE_KIND_BATTERY && deviceProxy.PowerSupply &&
                deviceProxy.ChargeThresholdSupported && deviceProxy.NativePath === this._deviceNativePath) {
                this._upowerDeviceProxy = deviceProxy;
                return;
            }
        }
    }

    // Resolves to null when the file is missing or unreadable; rejects only when cancelled.
    async _readFile(path) {
        try {
            const [contents] = await Gio.File.new_for_path(path).load_contents_async(this._cancellable);
            return new TextDecoder().decode(contents).trim();
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return null;
        }
    }

    async _sync() {
        const contents = this._chargeTypesPath ? await this._readFile(this._chargeTypesPath) : null;

        this.visible = contents !== null;
        if (contents !== null)
            this.checked = contents.includes(`[${FAST_CHARGE_TYPE}]`);
    }

    async _toggleRapidCharge() {
        if (!this._chargeTypesPath)
            return;

        const desiredType = this.checked ? FAST_CHARGE_TYPE : STANDARD_CHARGE_TYPE;

        // Neither Fast nor Standard is Long_Life, so UPower must not keep reporting the threshold as enabled.
        if (this._upowerDeviceProxy?.ChargeThresholdEnabled) {
            try {
                await this._upowerDeviceProxy.EnableChargeThresholdAsync(false);
            } catch (e) {
                console.error('Failed to sync UPower charge threshold state:', e);
            }
        }

        try {
            const bytes = new GLib.Bytes(new TextEncoder().encode(desiredType));
            await Gio.File.new_for_path(this._chargeTypesPath)
                .replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, this._cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            console.error('Failed to set charge type (see README for the required udev rule):', e);
        }

        await this._sync();
    }

    destroy() {
        GLib.Source.remove(this._pollSourceId);
        this._pollSourceId = null;

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
        this._indicator = new RapidChargingIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
