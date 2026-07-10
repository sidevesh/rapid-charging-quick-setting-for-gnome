import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const POWER_SUPPLY_DIR = '/sys/class/power_supply';
const CHARGE_TYPES_ATTR = 'charge_types';
const FAST_CHARGE_TYPE = 'Fast';
const STANDARD_CHARGE_TYPE = 'Standard';
const POLL_INTERVAL_SECONDS = 5;

const RapidChargingToggle = GObject.registerClass(
class RapidChargingToggle extends QuickSettings.QuickToggle {
    _init() {
        super._init({
            title: 'Rapid Charging',
            iconName: 'battery-full-charging-symbolic',
            toggleMode: true,
        });

        this._chargeTypesPath = null;
        this._pollSourceId = null;

        this.connect('clicked', () => this._toggleRapidCharge());

        this._findChargeTypesFile();
        this._pollSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this._sync();
            return GLib.SOURCE_CONTINUE;
        });
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
                const path = GLib.build_filenamev([POWER_SUPPLY_DIR, info.get_name(), CHARGE_TYPES_ATTR]);
                const contents = this._readFile(path);
                if (contents !== null && contents.includes(FAST_CHARGE_TYPE)) {
                    this._chargeTypesPath = path;
                    break;
                }
            }
            enumerator.close(null);
        } catch (e) {
            console.log('Failed to look for a rapid-charge-capable battery:', e);
        }

        this._sync();
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

    _toggleRapidCharge() {
        if (!this._chargeTypesPath)
            return;

        const desiredType = this.checked ? FAST_CHARGE_TYPE : STANDARD_CHARGE_TYPE;

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
