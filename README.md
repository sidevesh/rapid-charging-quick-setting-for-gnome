# Rapid Charging Quick Setting for GNOME

This allows you to seamlessly control Rapid Charge (a.k.a. Fast Charge) support on the Gnome desktop environment. It provides a quick setting toggle to enable or disable rapid charging via the kernel's `charge_types` battery attribute, directly from Gnome Shell.

This targets devices whose battery exposes a `charge_types` sysfs attribute with a `Fast` option, such as recent Lenovo IdeaPad/Yoga laptops supported by the `ideapad_laptop` kernel driver's Rapid Charge feature. Unlike battery charge threshold, GNOME's power settings and UPower do not expose Rapid Charge in any way, so this extension talks to the `charge_types` sysfs attribute directly instead of going through UPower.

<!-- Available at [GNOME Shell Extensions](https://extensions.gnome.org/extension/9573/rapid-charging-quick-setting/) -->

## Setup

Because this extension writes directly to a sysfs attribute, your user needs write permission on it. Install the provided udev rule once:

```sh
sudo cp udev/99-rapid-charging-quick-setting.rules /etc/udev/rules.d/
sudo usermod -aG power $USER   # skip if you're already in the "power" group
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Log out and back in for the group membership change to take effect.
