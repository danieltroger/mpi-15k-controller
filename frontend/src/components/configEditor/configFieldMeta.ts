import type { Config } from "../../../../backend/src/config/config.types";

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
export const HIDDEN_TOP_LEVEL_KEYS: Record<string, string> = {
  savedAuth_do_not_edit: "The saved ShineMonitor login token is managed automatically and is not editable here.",
};

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

function nextFullHourIso(): string {
  const start = new Date();
  start.setMinutes(60, 0, 0);
  return start.toISOString();
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
        "The inverter ramps grid feed-in from zero to full over about this long (grid safety) — plans account for it.",
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
        ["automatic_trading", "solar_model", "watts_per_direct_radiation"],
        "Direct radiation coefficient",
        "PV watts produced per W/m² of direct radiation — fitted against actual production.",
        { heading: "Solar model (locally calibrated)" }
      ),
      f(
        ["automatic_trading", "solar_model", "watts_per_diffuse_radiation"],
        "Diffuse radiation coefficient",
        "PV watts produced per W/m² of diffuse radiation — fitted against actual production."
      ),
      f(
        ["automatic_trading", "solar_model", "refit_interval_days"],
        "Refit interval",
        "Re-fit the two coefficients against actual production every N days (0 = never) — sun angles drift with the season.",
        { unit: "days" }
      ),
      f(
        ["automatic_trading", "solar_model", "last_fitted_at"],
        "Last fitted",
        "When the model was last calibrated (written by the fitter).",
        { readonly: true }
      ),
      f(
        ["automatic_trading", "solar_model", "fit_r2"],
        "Fit quality",
        "R² of the last calibration — 1 is a perfect fit (written by the fitter).",
        { readonly: true }
      ),
      f(
        ["automatic_trading", "solar_model", "fit_samples"],
        "Fit samples",
        "Hours of production data behind the last fit (written by the fitter).",
        { readonly: true }
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
        ["alerting", "inverter_temp_p1_celsius"],
        "Inverter temperature P1",
        "P1 when the inverter's hottest component reaches this — it hard-shuts-off at 100 °C.",
        { unit: "°C" }
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
        "P2 when every thermometer has been silent for this long.",
        { unit: "min" }
      ),
      f(["alerting", "error_log_p2"], "Forward error logs", "Send every backend errorLog() as a deduplicated P2.", {
        heading: "Delivery",
      }),
      f(["alerting", "digest_p3"], "Daily digests", "Quiet P3 pushes for the daily plan and settlement results."),
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
    description: "Names for the 1-wire temperature sensors and where their history goes.",
    rootKeys: ["thermometers", "temperature_report_interval", "temperature_saving"],
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
      f(["temperature_report_interval"], "Read interval", "How often temperatures are read and broadcast.", {
        unit: "ms",
      }),
      f(["temperature_saving", "database"], "History database", "InfluxDB database temperature history is written to."),
      f(["temperature_saving", "table"], "History table", "InfluxDB table temperature history is written to."),
    ],
  },
  {
    id: "connections",
    title: "Inverter & connections",
    description: "How the controller talks to the inverter and the outside world. Rarely touched.",
    rootKeys: [
      "usb_parameter_setting",
      "mqtt_host",
      "shinemonitor_user",
      "shinemonitor_password",
      "shinemonitor_company_key",
      "inverter_sn",
      "inverter_pn",
      "savedAuth_do_not_edit",
    ],
    fields: [
      f(
        ["usb_parameter_setting", "min_seconds_between_commands"],
        "Command spacing",
        "Minimum time between inverter parameter commands — it misbehaves when hurried.",
        { unit: "s" }
      ),
      f(
        ["usb_parameter_setting", "poll_values_interval_seconds"],
        "Settings poll interval",
        "How often the inverter's settings are read back outside of writes.",
        { unit: "s" }
      ),
      f(["mqtt_host"], "MQTT broker", "Host publishing the inverter telemetry the controller consumes."),
      f(["shinemonitor_user"], "ShineMonitor user", "Cloud login used to set inverter parameters remotely.", {
        heading: "ShineMonitor cloud",
      }),
      f(["shinemonitor_password"], "ShineMonitor password", "Cloud login password.", { secret: true }),
      f(["shinemonitor_company_key"], "Company key", "Vendor constant for the ShineMonitor API."),
      f(["inverter_sn"], "Inverter serial", "Auto-detected when blank."),
      f(["inverter_pn"], "Inverter part number", "Auto-detected when blank."),
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
