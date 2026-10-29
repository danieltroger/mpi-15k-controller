import type { Config } from "../../../../backend/src/config/config.types";
import {
  THERMOMETER_SWEEP_SETTING_BOUNDS,
  type ThermometerSweepSettingName,
} from "../../../../backend/src/temperatureMeasuring/thermometerSweepSettings";
import {
  SETTER_CHANGE_THROTTLE_BOUNDS,
  type SetterChangeThrottleSettingName,
} from "../../../../backend/src/inverterComms/setterChangeThrottle";
import {
  type BoundedPlannerKnobName,
  PLANNER_KNOB_BOUNDS,
} from "../../../../backend/src/autoTrading/plannerKnobBounds";

/**
 * Human explanations for every config value, grouped into page sections. The renderer walks this
 * table for order/labels/help, but coverage is guaranteed structurally: any config leaf that is
 * missing here still renders (with an auto-generated label) under "Other" — so a newly added
 * backend knob can never be invisible, just unexplained until someone writes its entry.
 */
export type ConfigFieldMeta = {
  /** Path from the Config root */
  path: readonly string[];
  label: string;
  help: string;
  unit?: string;
  /** Renders a select instead of a free input */
  options?: readonly { value: string; label: string }[];
  /** Starts a new visual group with this heading before the field */
  heading?: string;
  /** Shown but not editable (machine-written; the two ledger fields are also backend-rejected) */
  readonly?: boolean;
  /** Masked until focused (credentials) */
  secret?: boolean;
  /** Number input hints */
  min?: number;
  max?: number;
  step?: number;
  /** Marks this path as a keyed Record rendered by the map editor */
  map?: ConfigMapMeta;
};

export type ConfigMapColumn = {
  key: string;
  label: string;
  kind: "datetime" | "number" | "text";
  unit?: string;
};

export type ConfigMapMeta = {
  keyLabel: string;
  keyKind: "datetime" | "text";
  addLabel: string;
  /** Asked via prompt() for text-keyed maps */
  addPrompt?: string;
  /** Columns of the entry object; empty list = the entry value is itself a string */
  columns: readonly ConfigMapColumn[];
  /** Label for the single value column when `columns` is empty */
  valueLabel?: string;
  /** Fresh entry value for an added row */
  newEntryValue: (config: Config) => unknown;
};

export type ConfigSectionMeta = {
  id: string;
  title: string;
  description: string;
  /** Top-level Config keys this section renders (loose scalars can share one section) */
  rootKeys: readonly string[];
  /** Family-facing sections start open; plumbing starts collapsed */
  startOpen?: boolean;
  fields: readonly ConfigFieldMeta[];
};

/** Top-level keys deliberately not rendered anywhere (with the reason shown to the user). */
// Currently empty — the ShineMonitor auth blob this existed for died with the cloud dependency.
// Kept for the next machine-owned blob that should stay off the page (with its reason shown).
export const HIDDEN_TOP_LEVEL_KEYS: Record<string, string> = {};

const f = (
  path: readonly string[],
  label: string,
  help: string,
  extra?: Partial<ConfigFieldMeta>
): ConfigFieldMeta => ({
  path,
  label,
  help,
  ...extra,
});

/** Number-input hints for a thermometer sweep setting: the bounds the backend clamps to */
function sweepSettingInput(settingName: ThermometerSweepSettingName): Partial<ConfigFieldMeta> {
  const { min, max, unit } = THERMOMETER_SWEEP_SETTING_BOUNDS[settingName];
  return { unit, min, max, step: 1 };
}

function describeSweepSettingBounds(settingName: ThermometerSweepSettingName): string {
  const { min, max, unit, defaultValue } = THERMOMETER_SWEEP_SETTING_BOUNDS[settingName];
  return `${min}–${max} ${unit}, default ${defaultValue}.`;
}

/** Number-input hints for a write-throttle setting: the bounds the backend clamps to */
function throttleSettingInput(settingName: SetterChangeThrottleSettingName): Partial<ConfigFieldMeta> {
  const { min, max, unit } = SETTER_CHANGE_THROTTLE_BOUNDS[settingName];
  return { unit, min, max, step: 1 };
}

function describeThrottleSettingBounds(settingName: SetterChangeThrottleSettingName): string {
  const { min, max, unit, defaultValue } = SETTER_CHANGE_THROTTLE_BOUNDS[settingName];
  return `${min}–${max} ${unit}, default ${defaultValue}.`;
}
function plannerKnobInput(knobName: BoundedPlannerKnobName): Partial<ConfigFieldMeta> {
  const { min, max, unit } = PLANNER_KNOB_BOUNDS[knobName];
  return { unit, min, max, step: 100 };
}
function describePlannerKnobBounds(knobName: BoundedPlannerKnobName): string {
  const { min, max, unit, defaultValue } = PLANNER_KNOB_BOUNDS[knobName];
  return `${min}–${max} ${unit}, default ${defaultValue}; a value outside is clamped with a warning.`;
}

function hourAfterNextFullHourIso(): string {
  const start = new Date();
  start.setMinutes(120, 0, 0);
  return start.toISOString();
}

export const CONFIG_SECTIONS: readonly ConfigSectionMeta[] = [
  {
    id: "water-heater",
    title: "Water heater",
    description:
      "The boiler element in the tank. The Water heater card on the dashboard is the everyday on/off — these are the knobs behind it.",
    rootKeys: ["elpatron_switching"],
    startOpen: true,
    fields: [
      f(
        ["elpatron_switching", "mode"],
        "Mode",
        "Off keeps the element off, Always on lets the tank thermostat cap it, On solar power heats only when the sun covers it.",
        {
          options: [
            { value: "off", label: "Off" },
            { value: "always_on", label: "Always on" },
            { value: "solar", label: "On solar power" },
          ],
        }
      ),
      f(
        ["elpatron_switching", "min_solar_input"],
        "Solar power needed",
        "The element may switch on when solar production exceeds this (and nothing is being imported from the grid).",
        { unit: "W", min: 0, step: 100 }
      ),
      f(
        ["elpatron_switching", "tank_max_temperature"],
        "Tank thermostat cutoff",
        "Where the tank's own thermostat cuts the element — kept low since the boiler room gets warm.",
        { unit: "°C" }
      ),
      f(
        ["elpatron_switching", "element_watts"],
        "Element power draw",
        "Measured draw when on: about 2 kW per phase × 3 (July 2026). Used to predict heating cost and duration.",
        { unit: "W" }
      ),
      f(
        ["elpatron_switching", "tank_wh_per_degree"],
        "Tank heat capacity",
        "Energy that raises the tank sensor one degree — calibrated from a July 2026 burn (6.2 kW for 42 min lifted it 9.1 °C).",
        { unit: "Wh/°C" }
      ),
      f(
        ["elpatron_switching", "tank_cooling_degrees_per_hour"],
        "Tank cooling rate",
        "How fast the tank cools with the element off (standing loss).",
        { unit: "°C/h" }
      ),
      f(
        ["elpatron_switching", "heating_pi_ip"],
        "Heating-pi address",
        "IP of the Raspberry Pi that physically switches the element relay."
      ),
      f(
        ["elpatron_switching", "enabled"],
        "Solar gating (legacy switch)",
        "Older on/off flag kept in sync with Mode — Mode wins whenever it is set. Leave this alone."
      ),
    ],
  },
  {
    id: "trading",
    title: "Automatic trading",
    description:
      "The planner that sells battery power at expensive hours and buys at cheap ones. It runs daily when day-ahead prices publish and writes windows into the schedules below.",
    rootKeys: ["automatic_trading"],
    startOpen: true,
    fields: [
      f(
        ["automatic_trading", "enabled"],
        "Automatic trading",
        "Master switch. When on, the planner writes tomorrow's sell/buy windows every day; when off it plans nothing."
      ),
      f(
        ["automatic_trading", "plan_at_local_time"],
        "Daily planning time",
        "When the daily plan runs (HH:MM, Swedish time). Day-ahead prices publish around 13:00."
      ),
      f(
        ["automatic_trading", "price_area"],
        "Price area",
        "Spot price area (elprisetjustnu.se) — SE3 is middle Sweden."
      ),
      f(
        ["automatic_trading", "latitude"],
        "Latitude",
        "Where the panels are — drives the solar forecast (open-meteo).",
        { heading: "Solar forecast location" }
      ),
      f(
        ["automatic_trading", "longitude"],
        "Longitude",
        "Where the panels are — drives the solar forecast (open-meteo)."
      ),
      f(["automatic_trading", "max_sell_power_watts"], "Sell power", "Power written into planner sell windows.", {
        unit: "W",
        heading: "Power limits",
      }),
      f(
        ["automatic_trading", "min_sell_power_watts"],
        "Minimum reduced sell power",
        `When selling a quarter at full power would take the battery below the reserve, the planner sells that quarter at the most power that still fits, so the last bit of the day's sellable energy goes into the best remaining quarter. This is the least power it writes into any reduced-power sell window. Lower lets smaller leftovers be sold, but a window that small moves little energy (1.5 kW for 15 min is ~0.4 kWh) for a setpoint change and a ramp. Higher leaves more leftovers unsold or puts them into a cheaper slot that happens to be short enough (the current, partly gone quarter). At or above the sell power above, reduced-power windows are off. Applies from the next plan run. ${describePlannerKnobBounds("min_sell_power_watts")}`,
        plannerKnobInput("min_sell_power_watts")
      ),
      f(
        ["automatic_trading", "max_buy_power_watts"],
        "Buy charging power",
        "Charging power written into planner buy windows (mostly used to avert unavoidable imports).",
        { unit: "W" }
      ),
      f(
        ["automatic_trading", "inverter_max_ac_output_watts"],
        "Inverter AC ceiling",
        "Everything the inverter can put out at once — house and export share it, house first. 15 kW nameplate.",
        { unit: "W" }
      ),
      f(
        ["automatic_trading", "planner_soc_floor_percent"],
        "Planner floor",
        "Plans never let projected battery charge dip below this — the overnight safety margin. Also on the Trading page.",
        { unit: "% SOC", min: 0, max: 100, heading: "Battery floors & reserve" }
      ),
      f(
        ["automatic_trading", "planner_soc_floor_sunny_percent"],
        "Sunny floor",
        "Relaxed floor while forecast sun covers the house — a miss then costs minutes of import, not a stranded night.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["automatic_trading", "emergency_soc_floor_percent"],
        "Emergency floor",
        "Below this the battery is effectively empty and the house pulls from the grid; the planner prices those imports.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["automatic_trading", "extra_reserve_kwh"],
        "Extra reserve",
        "Energy kept on top of the floors when planning, e.g. for charging the car tonight.",
        { unit: "kWh", min: 0 }
      ),
      f(
        ["automatic_trading", "min_sell_spot_sek_per_kwh"],
        "Minimum sell price",
        "Don't bother selling below this spot price.",
        { unit: "SEK/kWh", heading: "Economics" }
      ),
      f(
        ["automatic_trading", "min_gain_sek_per_slot"],
        "Minimum gain per slot",
        "A 15-minute slot must be worth at least this to be scheduled.",
        { unit: "SEK" }
      ),
      f(
        ["automatic_trading", "min_buy_saving_sek_per_kwh"],
        "Minimum buy saving",
        "Buying must beat the alternative by this much per kWh — the margin also covers battery wear.",
        { unit: "SEK/kWh" }
      ),
      f(
        ["automatic_trading", "allow_arbitrage_buying"],
        "Arbitrage buying",
        "Allow buying cheap purely to re-sell at a later peak, when the spread beats fees, losses and the margin above."
      ),
      f(
        ["automatic_trading", "charge_efficiency"],
        "Charge efficiency",
        "Fraction of bought AC energy that actually lands in the battery.",
        { min: 0, max: 1, step: 0.01 }
      ),
      f(
        ["automatic_trading", "discharge_efficiency"],
        "Discharge efficiency",
        "Fraction of battery energy that comes back out as sellable AC.",
        { min: 0, max: 1, step: 0.01 }
      ),
      f(
        ["automatic_trading", "buy_surcharges_sek_per_kwh"],
        "Buy surcharges",
        "Fees on top of spot when buying, before VAT: grid transfer + energy tax + supplier markups.",
        { unit: "SEK/kWh" }
      ),
      f(
        ["automatic_trading", "vat_multiplier"],
        "VAT multiplier",
        "Applied to the whole buy price — 1.25 means 25 % VAT.",
        { unit: "×" }
      ),
      f(
        ["automatic_trading", "sell_bonus_sek_per_kwh"],
        "Sell extras",
        "What selling earns on top of spot: supplier markup + nätnytta.",
        { unit: "SEK/kWh" }
      ),
      f(
        ["automatic_trading", "sell_ramp_minutes"],
        "Feed-in ramp",
        "Minutes the inverter takes to ramp grid feed-in from zero to the full inverter AC ceiling (grid safety). Plans treat it as a rate: a smaller target gets there proportionally sooner (5 kW in a third of this), a step up mid-window climbs at the same rate, and a step down is immediate. Measured ~1.4 kW per minute, i.e. ~10.7 min to 15 kW. Set longer than the real ramp, plans count on less energy than each start and step-up delivers, so the battery ends lower than projected (the guard re-plans when that nears the floor); set shorter, plans count on more and a little stays unsold. Applies from the next plan run and guard check.",
        { unit: "min", heading: "Plan mechanics" }
      ),
      f(
        ["automatic_trading", "min_window_minutes"],
        "Minimum window",
        "Planned windows shorter than this are dropped — inverter command churn isn't free.",
        { unit: "min" }
      ),
      f(
        ["automatic_trading", "constraint_tail_hours"],
        "Constraint tail",
        "How far past the priced horizon the battery floors keep being enforced (covers the following night).",
        { unit: "h" }
      ),
      f(
        ["automatic_trading", "guard_interval_minutes"],
        "Guard interval",
        "How often the safety guard re-checks the written schedule against live battery charge (0 = off).",
        { unit: "min" }
      ),
      f(
        ["automatic_trading", "opportunistic_replan_interval_minutes"],
        "Replan interval",
        "How often to look for a better plan under live conditions (0 = off). The guard only shrinks plans; this can grow them.",
        { unit: "min" }
      ),
      f(
        ["automatic_trading", "opportunistic_replan_min_gain_sek"],
        "Replan threshold",
        "A replacement plan must beat the current one's projected revenue by this much to be applied.",
        { unit: "SEK" }
      ),
      f(
        ["automatic_trading", "replan_retry_minutes"],
        "Price retry interval",
        "Retry spacing while waiting for tomorrow's prices to publish.",
        { unit: "min" }
      ),
      f(
        ["automatic_trading", "fallback_house_load_watts"],
        "Fallback house load",
        "Assumed house consumption if the InfluxDB history is unavailable.",
        { unit: "W" }
      ),
      f(
        ["automatic_trading", "solar_model", "string1", "tilt_degrees"],
        "String 1 (MPPT1) tilt",
        "Panel tilt from horizontal (owner-measured). Changing it discards the learned shading mask until the next refit (retried every 3 hours).",
        {
          unit: "°",
          min: 0,
          max: 90,
          heading: "Solar model (physical, per string)",
        }
      ),
      f(
        ["automatic_trading", "solar_model", "string1", "azimuth_degrees"],
        "String 1 (MPPT1) facing",
        "Compass direction the panels face: 180 = south, 270 = west. Changing it discards the learned shading mask until the next refit.",
        { unit: "°", min: 0, max: 360 }
      ),
      f(
        ["automatic_trading", "solar_model", "string1", "nameplate_kwp"],
        "String 1 (MPPT1) nameplate",
        "Module nameplate total. Only a plausibility bound for the fitted capacity (a fit outside 50–105 % of it pages) — never used to predict.",
        { unit: "kWp" }
      ),
      f(
        ["automatic_trading", "solar_model", "string1", "max_current_amps"],
        "String 1 (MPPT1) current cap",
        "The MPPT input's current limit; the model caps power at this × the typical MPP voltage. It has never bound in the history (max 10-min mean 22.65 A).",
        { unit: "A" }
      ),
      f(
        ["automatic_trading", "solar_model", "string1", "typical_mpp_volts"],
        "String 1 (MPPT1) MPP voltage",
        "Typical string voltage at full power, for the current cap above.",
        { unit: "V" }
      ),
      f(
        ["automatic_trading", "solar_model", "string2", "tilt_degrees"],
        "String 2 (MPPT2) tilt",
        "Panel tilt from horizontal (owner-measured). Changing it discards the learned shading mask until the next refit (retried every 3 hours).",
        {
          unit: "°",
          min: 0,
          max: 90,
        }
      ),
      f(
        ["automatic_trading", "solar_model", "string2", "azimuth_degrees"],
        "String 2 (MPPT2) facing",
        "Compass direction the panels face: 180 = south, 270 = west. Changing it discards the learned shading mask until the next refit.",
        { unit: "°", min: 0, max: 360 }
      ),
      f(
        ["automatic_trading", "solar_model", "string2", "nameplate_kwp"],
        "String 2 (MPPT2) nameplate",
        "Module nameplate total. Only a plausibility bound for the fitted capacity (a fit outside 50–105 % of it pages) — never used to predict.",
        { unit: "kWp" }
      ),
      f(
        ["automatic_trading", "solar_model", "string2", "max_current_amps"],
        "String 2 (MPPT2) current cap",
        "The MPPT input's current limit; the model caps power at this × the typical MPP voltage. It has never bound in the history (max 10-min mean 22.65 A).",
        { unit: "A" }
      ),
      f(
        ["automatic_trading", "solar_model", "string2", "typical_mpp_volts"],
        "String 2 (MPPT2) MPP voltage",
        "Typical string voltage at full power, for the current cap above.",
        { unit: "V" }
      ),
      f(
        ["automatic_trading", "solar_model", "rewired_at"],
        "Re-wiring date",
        "Before this instant MPPT1 and MPPT2 were the two halves of string 1's roof, so the history counts both as string 1 and string 2 starts here. Empty = never re-wired."
      ),
      f(
        ["automatic_trading", "solar_model", "history_start"],
        "History start",
        "Oldest production history the refit learns from (the shading mask needs at least a full year of sun positions)."
      ),
      f(
        ["automatic_trading", "solar_model", "refit_every_days"],
        "Refit interval",
        "Re-learn capacity, sky factor and shading mask from all history this often (at night, in a separate process so the controller never stalls). Fit state lives in backend/solar_model_state.json.",
        { unit: "days", min: 1 }
      ),
      f(
        ["automatic_trading", "solar_model", "mask_half_life_days"],
        "Recency half-life",
        "An observation this old counts half in the refit. The trees have stopped growing, so the mask is nearly static; a cut-down tree is learned within one season of sun passing that sector. 0 = all history equal.",
        { unit: "days", min: 0 }
      ),
      f(
        ["automatic_trading", "solar_model", "mask_irradiance_source"],
        "Mask irradiance",
        "What the shading mask is fitted against. Satellite (EUMETSAT SARAH-3, ~2 days behind) is the best record of what the sun really did; the forecast archive is the automatic fallback and scored the same in the backtest.",
        {
          options: [
            { value: "satellite", label: "Satellite (SARAH-3)" },
            { value: "forecast_archive", label: "Forecast archive" },
          ],
        }
      ),
      f(
        ["automatic_trading", "solar_model", "snow_nowcast"],
        "Snow nowcast",
        "While the forecast says snow may be on the panels, scale each string down by its own recent production deficit (string 1 is never cleared, string 2 sometimes)."
      ),
    ],
  },
  {
    id: "alerts",
    title: "Alerts",
    description:
      "Pushover notifications when something needs a human: P1 wakes people up, P2 is urgent, P3 is informational.",
    rootKeys: ["alerting"],
    fields: [
      f(
        ["alerting", "enabled"],
        "Alerting",
        "Master switch — with it off, rules still evaluate but nothing is recorded or pushed."
      ),
      f(
        ["alerting", "dry_run"],
        "Dry run",
        "Burn-in mode: log what would have been pushed instead of pushing. Cooldowns behave as live."
      ),
      f(
        ["alerting", "site_name"],
        "Site name",
        "Prefixed to every alert title so Örebro and Göteborg pushes are tellable apart."
      ),
      f(["alerting", "pushover_app_token"], "Pushover app token", "Application token from pushover.net/apps.", {
        secret: true,
      }),
      f(
        ["alerting", "pushover_recipient_key"],
        "Pushover recipient",
        "Delivery-group key (whole family) or a single user key.",
        { secret: true }
      ),
      f(
        ["alerting", "battery_temp_p1_celsius"],
        "Battery temperature P1",
        "P1 when any battery probe reaches this; clears 3 °C lower.",
        { unit: "°C", heading: "Alarm thresholds" }
      ),
      f(
        ["alerting", "cooling_outlet_temp_p2_celsius"],
        "Cooling outlet P2",
        "P2 on the hottest cooling outlet — the early ventilation warning. Would have caught the 2025-06-30 shutdown ~80 min ahead.",
        { unit: "°C" }
      ),
      f(
        ["alerting", "charging_battery_temp_p1_celsius"],
        "Cold charging P1",
        "P1 when charging over 200 W with any battery probe at or below this — LiFePO4 must not charge below freezing.",
        { unit: "°C" }
      ),
      f(
        ["alerting", "battery_undervoltage_p2_volts"],
        "Undervoltage P2",
        "P2 below this pack voltage (2.5 V per cell = 40 V is the absolute floor).",
        { unit: "V" }
      ),
      f(
        ["alerting", "battery_overvoltage_p1_volts"],
        "Overvoltage P1",
        "P1 above this pack voltage (3.65 V per cell = 58.4 V is the charge ceiling).",
        { unit: "V" }
      ),
      f(
        ["alerting", "grid_out_below_volts"],
        "Grid-out voltage",
        "The grid counts as down when phase R sits below this…",
        { unit: "V" }
      ),
      f(["alerting", "grid_out_p2_seconds"], "Grid-out delay", "…for at least this long (then a P2).", { unit: "s" }),
      f(
        ["alerting", "stale_mqtt_p2_minutes"],
        "Stale inverter data P2",
        "P2 when no inverter value has updated for this long (USB daemon dead).",
        { unit: "min" }
      ),
      f(
        ["alerting", "stale_temperatures_p2_minutes"],
        "Stale thermometers P2",
        "P2 when every thermometer has been silent for this long. Never sooner than three thermometer sweep intervals (Thermometers → Sweep interval), so slow sweeps can't trip it.",
        { unit: "min" }
      ),
      f(
        ["alerting", "inverter_stuck_p2"],
        "Stuck inverter alert",
        "P2 when the inverter's DC side looks latched off (battery idle with the house on grid, PV idle in daylight, or a grid-charge window that charges nothing) — the October 2026 failure that ran 59 h unnoticed and needed a power-cycle. One alert for all three signs, then a quiet P3 once power flows again.",
        { heading: "Stuck inverter" }
      ),
      f(
        ["alerting", "inverter_stuck_sustain_minutes"],
        "Idle / PV-stall delay",
        "How long the battery-idle or PV-stalled picture must hold before alerting. Replaying October 2026, it alerts 31 min after the inverter stopped.",
        { unit: "min", min: 1 }
      ),
      f(
        ["alerting", "inverter_stuck_buy_window_sustain_minutes"],
        "Buy-window delay",
        "How long a grid-charge window the inverter has confirmed may go without the battery charging before alerting. Healthy windows reach full current within about a minute.",
        { unit: "min", min: 1 }
      ),
      f(
        ["alerting", "inverter_stuck_p1_after_minutes"],
        "Escalate to P1 after",
        "Page as P1 (rings through Do Not Disturb) if it is still seen stuck this long after the first alert; never once a fix has shown up. 0 = never escalate. Sent as P2 instead if the fault-mode P1 below already paged for the same episode.",
        { unit: "min", min: 0 }
      ),
      f(
        ["alerting", "solar_forecast_accuracy_p2"],
        "PV forecast accuracy",
        "P2 when the day-ahead PV forecast has been badly off for a week, two daily checks in a row. One push per episode; snow and outage days don't count. Backtest: 1 push in 26 months, against 8 for the old model.",
        { heading: "PV forecast accuracy" }
      ),
      f(
        ["alerting", "solar_forecast_week_min_ratio"],
        "Week too dark",
        "…when actual/forecast PV over the last 7 days falls below this (only weeks forecasting at least 70 kWh).",
        { min: 0, max: 1, step: 0.05 }
      ),
      f(["alerting", "solar_forecast_week_max_ratio"], "Week too bright", "…or rises above this.", {
        min: 1,
        step: 0.05,
      }),
      f(
        ["alerting", "solar_forecast_week_max_error_share"],
        "Week error share",
        "…or the summed daily misses exceed this share of the week's forecast (at least 35 kWh as the base).",
        { min: 0, step: 0.05 }
      ),
      f(
        ["alerting", "inverter_fault_mode_p1"],
        "Fault-mode alert",
        "P1 when the inverter itself reports Fault mode — as it did for 59 h with fault 14 in October 2026. The page names the fault code and how to power-cycle the inverter; a quiet P3 follows once it runs again. A controller restart within the alert cooldown keeps the page; after a longer downtime it pages again.",
        { heading: "Inverter fault" }
      ),
      f(
        ["alerting", "inverter_fault_mode_p1_after_seconds"],
        "Fault-mode delay",
        "How long Fault mode must be read continuously before paging: a later reading must still say Fault mode. The mode is read once a minute, and at once when the battery goes idle (which restarts its minute), so at 60 s the page comes about 1.5 minutes after the fault, at most ~2.5.",
        { unit: "s", min: 0 }
      ),
      f(
        ["alerting", "inverter_fault_code_p2"],
        "New fault code alert",
        "P2 when the inverter records a new fault code that the fault-mode P1 isn't already reporting — e.g. one it recovered from by itself."
      ),
      f(
        ["alerting", "inverter_bypass_p2"],
        "Bypass alert",
        "P2 when the inverter sits in Bypass mode with the grid present: the house runs straight off the grid with no backup. So far this has only happened with the battery disconnected. Quiet P3 when it ends."
      ),
      f(
        ["alerting", "inverter_bypass_p2_after_seconds"],
        "Bypass delay",
        "How long Bypass mode must last before alerting.",
        { unit: "s", min: 0 }
      ),
      f(["alerting", "error_log_p2"], "Forward error logs", "Send every backend errorLog() as a deduplicated P2.", {
        heading: "Delivery",
      }),
      f(["alerting", "digest_p3"], "Daily digests", "Quiet P3 pushes for the daily plan and settlement results."),
      f(
        ["alerting", "trading_guard_p2"],
        "Trading guard alerts",
        "P2 when the trading guard sheds windows after a projected reserve breach. Off by default — that is routine guard behaviour; a guard re-plan that actually fails still alerts via the error-log forwarding above."
      ),
      f(["alerting", "cooldown_minutes"], "Cooldown", "Per-alert re-send suppression window.", { unit: "min" }),
      f(
        ["alerting", "max_pushes_per_hour"],
        "Hourly push cap",
        "Global cap (P1 exempt) so a bug can't machine-gun the family or the API quota."
      ),
      f(
        ["alerting", "max_errorlog_pushes_per_hour"],
        "Hourly error-log cap",
        "Separate budget for forwarded error logs so log noise can't crowd out real alarms."
      ),
      f(
        ["alerting", "startup_grace_seconds"],
        "Startup grace",
        "No staleness alerts this soon after boot — sensors come up in their own time.",
        { unit: "s" }
      ),
    ],
  },
  {
    id: "selling",
    title: "Sell windows & guards",
    description:
      "When to feed battery power into the grid, and the hard stops that pause it. The Trading page has the comfortable schedule editor; rows written by the auto-trader appear here too.",
    rootKeys: ["scheduled_power_selling"],
    fields: [
      f(
        ["scheduled_power_selling", "schedule"],
        "Sell schedule",
        "Each row is one window: feed the grid at this power between start and end.",
        {
          map: {
            keyLabel: "Start",
            keyKind: "datetime",
            addLabel: "+ Sell window",
            columns: [
              { key: "end_time", label: "End", kind: "datetime" },
              { key: "power_watts", label: "Power", kind: "number", unit: "W" },
            ],
            newEntryValue: config => ({
              end_time: hourAfterNextFullHourIso(),
              power_watts: config.automatic_trading.max_sell_power_watts,
            }),
          },
        }
      ),
      f(
        ["scheduled_power_selling", "only_sell_above_soc"],
        "Stop selling below",
        "Selling pauses the moment battery charge drops under this.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["scheduled_power_selling", "start_selling_again_above_soc"],
        "Resume selling above",
        "…and resumes only once charge has recovered past this.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["scheduled_power_selling", "only_sell_above_voltage"],
        "Stop selling below",
        "Voltage sags under load — this catches an empty battery faster than SOC can.",
        { unit: "V" }
      ),
      f(
        ["scheduled_power_selling", "start_selling_again_above_voltage"],
        "Resume selling above",
        "Recovery voltage before selling may continue.",
        { unit: "V" }
      ),
      f(
        ["scheduled_power_selling", "only_sell_below_inverter_temp_celsius"],
        "Stop selling at",
        "Selling stops the moment the inverter's hottest component reaches this, and a P1 goes out (check the door and ventilation). At 100 °C it shuts down until power-cycled, as on 2025-06-30.",
        { unit: "°C", heading: "Inverter overheating" }
      ),
      f(
        ["scheduled_power_selling", "start_selling_again_below_inverter_temp_celsius"],
        "Resume selling below",
        "…and resumes, with a quiet P3, only once it has cooled under this. The gap keeps it from flapping on and off.",
        { unit: "°C" }
      ),
    ],
  },
  {
    id: "buying",
    title: "Buy windows & guards",
    description: "When to charge the battery from the grid, and the hard stops around it.",
    rootKeys: ["scheduled_power_buying"],
    fields: [
      f(
        ["scheduled_power_buying", "schedule"],
        "Buy schedule",
        "Each row is one window: charge from the grid at this power between start and end.",
        {
          map: {
            keyLabel: "Start",
            keyKind: "datetime",
            addLabel: "+ Buy window",
            columns: [
              { key: "end_time", label: "End", kind: "datetime" },
              { key: "charging_power", label: "Charging power", kind: "number", unit: "W" },
            ],
            newEntryValue: config => ({
              end_time: hourAfterNextFullHourIso(),
              charging_power: config.automatic_trading.max_buy_power_watts,
            }),
          },
        }
      ),
      f(
        ["scheduled_power_buying", "only_buy_below_soc"],
        "Stop charging above",
        "Grid charging stops once battery charge reaches this.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["scheduled_power_buying", "start_buying_again_below_soc"],
        "Resume charging below",
        "…and starts again only if charge falls back under this.",
        { unit: "% SOC", min: 0, max: 100 }
      ),
      f(
        ["scheduled_power_buying", "max_grid_input_amperage"],
        "Max grid draw",
        "Cap on total grid current while charging — protects the main fuse.",
        { unit: "A", min: 0 }
      ),
    ],
  },
  {
    id: "charging",
    title: "Battery charging",
    description:
      "Voltage thresholds the controller uses to decide when the battery is full and when to start charging it from solar.",
    rootKeys: [
      "full_battery_voltage",
      "float_charging_voltage",
      "start_bulk_charge_voltage",
      "start_bulk_charge_after_wh_discharged",
      "stop_charging_below_current",
    ],
    fields: [
      f(
        ["full_battery_voltage"],
        "Full voltage",
        "Pack voltage treated as full — 58.4 V is the 3.65 V-per-cell charge ceiling.",
        { unit: "V" }
      ),
      f(["float_charging_voltage"], "Float voltage", "Voltage the pack is held at once full.", { unit: "V" }),
      f(
        ["start_bulk_charge_voltage"],
        "Bulk charge below",
        "Under this pack voltage a new full charge cycle may start.",
        { unit: "V" }
      ),
      f(
        ["start_bulk_charge_after_wh_discharged"],
        "Bulk charge after discharge",
        "…or after this much energy has been drawn since the last full charge.",
        { unit: "Wh" }
      ),
      f(
        ["stop_charging_below_current"],
        "Charge done current",
        "Charging counts as finished when charge current falls below this.",
        { unit: "A" }
      ),
    ],
  },
  {
    id: "soc",
    title: "Battery charge estimation (Ah ledger)",
    description:
      "How the battery percentage is computed: amp-counting from hall sensor 2, anchored at full/empty events. The two tracked parameters are controller-owned and locked here.",
    rootKeys: ["soc_calculations"],
    fields: [
      f(["soc_calculations", "battery_empty_at"], "Empty voltage", "Pack voltage treated as hard empty.", {
        unit: "V",
      }),
      f(["soc_calculations", "table"], "InfluxDB table", "Where computed SOC values are written."),
      f(
        ["soc_calculations", "ah_ledger", "capacity_ah"],
        "Pack capacity",
        "Usable capacity, tracked online from deep full↔empty spans. Controller-owned — to seed it manually, stop the service and edit config.json.",
        { unit: "Ah", readonly: true }
      ),
      f(
        ["soc_calculations", "ah_ledger", "drain_a"],
        "Baseline drain",
        "Constant amps subtracted every hour (sensor zero-bias + parasitic draw, seasonal). Tracked online; controller-owned like capacity.",
        { unit: "A", readonly: true }
      ),
      f(
        ["soc_calculations", "ah_ledger", "drain_ema_tau_days"],
        "Drain tracking speed",
        "Time constant for the online drain tracking — bigger adapts slower.",
        { unit: "days" }
      ),
      f(
        ["soc_calculations", "ah_ledger", "v_discharge"],
        "Reference discharge voltage",
        "Mean discharge-branch terminal voltage from the offline calibration. Recorded for reference; unused in control.",
        { unit: "V" }
      ),
      f(
        ["soc_calculations", "ah_ledger", "v_charge"],
        "Reference charge voltage",
        "Mean charge-branch terminal voltage from the offline calibration. Recorded for reference; unused in control.",
        { unit: "V" }
      ),
      f(
        ["soc_calculations", "ah_ledger", "soft_empty", "voltage"],
        "Soft-empty voltage",
        "The pack often only drains to ~49 V, not hard empty — crossing this while nearly at rest anchors the ledger.",
        { unit: "V", heading: "Soft-empty anchor" }
      ),
      f(
        ["soc_calculations", "ah_ledger", "soft_empty", "max_abs_amps"],
        "At-rest current",
        "“Nearly at rest” means battery current magnitude below this.",
        { unit: "A" }
      ),
      f(
        ["soc_calculations", "ah_ledger", "soft_empty", "soc_percent"],
        "Anchor charge",
        "Battery percentage assumed at a soft-empty anchor.",
        { unit: "%" }
      ),
    ],
  },
  {
    id: "feeding",
    title: "Grid feeding (no solar)",
    description:
      "The always-on subsystem that feeds the house from the battery when the sun is gone, and decides when solar surplus is let through to the grid.",
    rootKeys: ["feed_from_battery_when_no_solar"],
    fields: [
      f(
        ["feed_from_battery_when_no_solar", "feed_amount_watts"],
        "Base feed",
        "Battery feed-in while the house runs without solar.",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "feed_below_available_power"],
        "Start feeding below",
        "Feeding starts when available solar power drops under this.",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "add_to_feed_below_when_currently_feeding"],
        "Keep-feeding margin",
        "While already feeding, the start threshold is raised by this much (hysteresis against flapping).",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "increment_with_on_peak"],
        "Peak boost",
        "Extra feed-in added when a consumption peak is detected.",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "peak_increment_duration"],
        "Peak boost duration",
        "How long the peak boost stays applied.",
        { unit: "s" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "peak_min_change"],
        "Peak detection step",
        "A consumption jump of at least this counts as a peak.",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "max_feed_in_power_when_feeding_from_solar"],
        "Solar feed-in cap",
        "Cap on grid feed-in while running on solar.",
        { unit: "W" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "disable_below_battery_voltage"],
        "No feeding below",
        "Battery feeding is disabled under this pack voltage.",
        { unit: "V" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "should_feed_debounce_time"],
        "Decision debounce",
        "Feed on/off decisions must hold for this long before acting.",
        { unit: "ms" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "allow_switching_to_solar_feeding_during_charging_x_volts_below_full"],
        "Early solar-feed window",
        "While charging, switching to solar feeding is allowed once within this many volts of full.",
        { unit: "V" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "force_let_through_to_grid_over_pv_voltage1"],
        "PV1 protection voltage",
        "Above this PV string 1 voltage, surplus is forced through to the grid.",
        { unit: "V" }
      ),
      f(
        ["feed_from_battery_when_no_solar", "force_let_through_to_grid_over_pv_voltage2"],
        "PV2 protection voltage",
        "Above this PV string 2 voltage, surplus is forced through to the grid.",
        { unit: "V" }
      ),
    ],
  },
  {
    id: "current",
    title: "Current sensors",
    description: "The two hall-effect sensors on the battery cables — sensor 2 (positive pole) feeds the Ah ledger.",
    rootKeys: ["current_measuring"],
    fields: [
      f(
        ["current_measuring", "enabled"],
        "Sensors enabled",
        "Read the i2c hall sensors at all. Debug flag — leave on."
      ),
      f(["current_measuring", "zero_current_millivolts"], "Sensor 1 zero point", "Sensor 1 output at 0 A.", {
        unit: "mV",
      }),
      f(["current_measuring", "millivolts_per_ampere"], "Sensor 1 scale", "Sensor 1 output change per ampere.", {
        unit: "mV/A",
      }),
      f(
        ["current_measuring", "zero_current_millivolts2"],
        "Sensor 2 zero point",
        "Sensor 2 (positive pole, feeds the Ah ledger) output at 0 A.",
        { unit: "mV" }
      ),
      f(["current_measuring", "millivolts_per_ampere2"], "Sensor 2 scale", "Sensor 2 output change per ampere.", {
        unit: "mV/A",
      }),
      f(["current_measuring", "average_over_time_ms"], "Averaging window", "Window for the smoothed current value.", {
        unit: "ms",
      }),
      f(["current_measuring", "rate_constant"], "Rate constant", "Legacy smoothing constant for derived rates.", {}),
      f(["current_measuring", "table"], "InfluxDB table", "Where raw current readings are written."),
    ],
  },
  {
    id: "thermometers",
    title: "Thermometers",
    description: "Names for the 1-wire temperature sensors, how often they're read and where their history goes.",
    rootKeys: ["thermometers", "temperature_saving"],
    fields: [
      f(
        ["thermometers"],
        "Sensor labels",
        "Readings appear under these names everywhere (dashboard, alerts, history).",
        {
          map: {
            keyLabel: "Device id",
            keyKind: "text",
            addLabel: "+ Thermometer",
            addPrompt: "1-wire device id (e.g. 28-00000e8d0b6a):",
            columns: [],
            valueLabel: "Label",
            newEntryValue: () => "",
          },
        }
      ),
      f(
        ["temperature_saving", "thermometer_sweep_interval_seconds"],
        "Sweep interval",
        `How often all thermometers are read, from the start of one sweep to the start of the next. A sweep runs one 12-bit conversion on every probe at once (~0.75 s) and then reads all of them, about 1.2 s in total, so 0 or anything shorter than that sweeps back to back: each sweep starts as soon as the previous one ends, and they never overlap. Without the bulk read, every probe converts on its own and a sweep takes ~11 s. Shorter means fresher temperatures and quicker temperature alerts, but more InfluxDB rows (one per probe per sweep), more MQTT and live-page traffic, more CPU for the bus's bit-banged reads, and near-continuous conversions warm each probe by a few tenths of a degree. Longer delays the battery and cooling-outlet alerts by up to one interval, which is why it stops at 60 s: the battery P1 is then at most about a minute late. Stale thermometers waits at least three intervals. A single probe that stops reading pages after the silent-probe delay below or after three failed sweeps, whichever is later. Applies from the next sweep. ${describeSweepSettingBounds("thermometer_sweep_interval_seconds")}`,
        sweepSettingInput("thermometer_sweep_interval_seconds")
      ),
      f(
        ["temperature_saving", "thermometer_silent_page_after_minutes"],
        "Silent probe alert after",
        `P2 when one thermometer has given no reading since its last good one for this long or for three failed sweeps in a row, whichever is later (so one failed sweep at a long interval can't page). Stale thermometers only fires once every probe is quiet, so without this a single dark battery probe goes unnoticed (cell_5 was dark for 40 min in October 2026). A probe stuck at its 85 °C power-on value counts as silent. Shorter pages sooner, but also on a passing run of read errors; longer leaves a dark probe unnoticed longer. Applies from the next sweep. ${describeSweepSettingBounds("thermometer_silent_page_after_minutes")}`,
        sweepSettingInput("thermometer_silent_page_after_minutes")
      ),
      f(
        ["temperature_saving", "thermometer_bulk_retry_interval_seconds"],
        "Bulk read retry",
        `While the bulk read (one conversion for all probes) fails, for example without its udev permission rule or on a kernel that ignores the trigger, sweeps read probe by probe with a conversion each (~11 s per sweep) and try the bulk read again this often. Shorter gets back to fast sweeps sooner once the cause is fixed, but each failed try can add about a second to its sweep. The outage is warned about once, and its end is logged. Applies from the next sweep. ${describeSweepSettingBounds("thermometer_bulk_retry_interval_seconds")}`,
        sweepSettingInput("thermometer_bulk_retry_interval_seconds")
      ),
      f(["temperature_saving", "database"], "History database", "InfluxDB database temperature history is written to."),
      f(["temperature_saving", "table"], "History table", "InfluxDB table temperature history is written to."),
    ],
  },
  {
    id: "connections",
    title: "Inverter & connections",
    description: "How the controller talks to the inverter and the outside world. Rarely touched.",
    rootKeys: ["usb_parameter_setting", "mqtt_host"],
    fields: [
      f(
        ["usb_parameter_setting", "min_seconds_between_setting_changes"],
        "Time between setting changes",
        `How long the AC charging current (MUCHGC) and the feed-in limit (GPMP) each keep a target before the next change is written. During a buy window the charging current follows the house load, and without a pause it was rewritten every ~14 s over 1–2 A of noise. In the evening of 2026-10-27 that coincided with the inverter dropping off the grid five times ("AC input island"). Never held: a buy window starting or ending (the end's 10 A step-down included), feeding switching between solar only, the battery and selling, switching AC charging or feeding on or off, the first value after a restart, and a large charging-current decrease (next setting). Longer means fewer writes, but a higher target (more charging, a peak boost) arrives later, and a small decrease can keep the charging current up to the next setting's amount too high for that long (longer while a load keeps creeping up). It can't go below 15 s: since the quiet gap after each write is gone (#52) nothing else spaces these writes, and a target that changes and changes back faster than the inverter commits and the controller reads it back would look like a setting that never applied and page; a smaller value is raised to 15 s with a warning. Applies at once. ${describeThrottleSettingBounds("min_seconds_between_setting_changes")}`,
        throttleSettingInput("min_seconds_between_setting_changes")
      ),
      f(
        ["usb_parameter_setting", "ac_charging_current_immediate_decrease_amps"],
        "Charging decrease written at once",
        `A charging current target at least this many amps (battery side) below the last one is written straight away, ignoring the time between changes, so a load coming on during a buy window (the EV, a kettle) can never overload a phase. Smaller decreases wait like increases. The charging current then always stays less than this amount above the wanted one, and 10 A is at most about 0.9 A per phase (at a full battery's 57.6 V), so the busiest phase can go that far over the max grid draw. Each held decrease waits at most the time between changes, but while a load creeps up the holds can follow each other: on 2026-10-27 the overshoot peaked at 8 A and back-to-back holds lasted up to 82 s. Lower lets more of the noise through as writes. 0 writes every decrease at once. Higher lets a bigger overshoot wait, so it stops at 30 A (about 2.7 A per phase). Applies at once. ${describeThrottleSettingBounds("ac_charging_current_immediate_decrease_amps")}`,
        throttleSettingInput("ac_charging_current_immediate_decrease_amps")
      ),
      f(
        ["usb_parameter_setting", "poll_values_interval_seconds"],
        "Settings poll interval",
        "How often the inverter's settings are read back outside of writes. Each write is read back on its own from 9 s after it, every 4 s, until it shows, with an alert if it hasn't after 55 s — or, for a setting whose newer writes kept replacing the check, once its readback hasn't changed for 60 s since one of them.",
        { unit: "s" }
      ),
      f(
        ["mqtt_host"],
        "MQTT broker",
        "Broker the controller publishes inverter telemetry, temperatures and SOC to (telegraf feeds them into InfluxDB)."
      ),
    ],
  },
  {
    id: "influxdb",
    title: "InfluxDB",
    description: "The time-series database (on the Mac mini) that power history is read from and written to.",
    rootKeys: ["influxdb"],
    fields: [
      f(["influxdb", "host"], "Host", "InfluxDB server address."),
      f(["influxdb", "database"], "Database", "Database name for power history."),
      f(["influxdb", "username"], "Username", "InfluxDB login."),
      f(["influxdb", "password"], "Password", "InfluxDB login password.", { secret: true }),
    ],
  },
];

/** Sentence-case a snake_case key for config leaves that have no meta entry yet. */
export function autoLabelForKey(key: string): string {
  const spaced = key.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
