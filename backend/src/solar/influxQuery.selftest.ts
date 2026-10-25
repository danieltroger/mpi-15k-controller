/**
 * The InfluxDB password must never reach a string that is logged, persisted or pushed. Run from
 * backend/ with:
 *   yarn node src/solar/influxQuery.selftest.ts
 */
import { describeError } from "./errorDescription.ts";
import { influxHttpQuery } from "./influxQuery.ts";
import { emptyRefitStatus, recordFailure } from "./solarRefit.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const PASSWORD = "s3cret-Passw0rd";
const USERNAME = "grafana";

// ---------- malformed hosts: the error names the host, never the credentials ----------
for (const host of ["192.168.1.1022", "192.168.1.102 ", "192.168.1.102:80860"]) {
  let failure: unknown;
  try {
    const query = influxHttpQuery({ host, database: "mppsolar", username: USERNAME, password: PASSWORD });
    await query("SELECT 1", 1000);
  } catch (error) {
    failure = error;
  }
  const message = describeError(failure);
  const logged = await captureConsole(() => {
    const status = emptyRefitStatus();
    recordFailure(status, {
      nowMs: Date.parse("2026-07-04T01:40:00Z"),
      incumbent: undefined,
      refit_every_days: 30,
      error: failure,
    });
    // A day later the "no fit for a day" P2 fires with the reason in its text
    recordFailure(status, {
      nowMs: Date.parse("2026-07-05T02:40:00Z"),
      incumbent: undefined,
      refit_every_days: 30,
      error: failure,
    });
    return status.last_reason ?? "";
  });
  const leaks = [message, logged.result, logged.output].filter(text => text.includes(PASSWORD));
  check(
    `credentials: ${JSON.stringify(host)} fails without the password in the error, last_reason or logs`,
    failure !== undefined && leaks.length === 0 && message.includes("invalid influxdb.host"),
    `(${message})`
  );
}

// ---------- a good host: credentials only in the Authorization header ----------
{
  const requests: { url: string; authorization: string | null }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(
      JSON.stringify({ results: [{ series: [{ columns: ["time", "value"], values: [[1000, 42]] }] }] }),
      {
        status: 200,
      }
    );
  }) as typeof fetch;
  const query = influxHttpQuery({
    host: "192.168.1.102",
    database: "mppsolar",
    username: USERNAME,
    password: PASSWORD,
  });
  const rows = await query<{ time: number; value: number }>("SELECT 1", 1000);
  globalThis.fetch = originalFetch;
  const [request] = requests;
  check(
    "credentials: the URL carries neither username nor password",
    !!request && !request.url.includes(PASSWORD) && !request.url.includes(`u=${USERNAME}`),
    `(${request?.url})`
  );
  check(
    "credentials: sent as HTTP Basic auth",
    request?.authorization === `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`
  );
  check("query: rows come back with epoch-ms time", rows.length === 1 && rows[0].time === 1000 && rows[0].value === 42);
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll credential checks passed");
process.exit(fails.length ? 1 : 0);

/** Runs `action` with console.log/warn/error captured (so logged text can be checked for secrets) */
async function captureConsole<Result>(action: () => Result): Promise<{ result: Result; output: string }> {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) =>
    lines.push(
      args.map(argument => (argument instanceof Error ? describeError(argument) : String(argument))).join(" ")
    );
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { result: action(), output: lines.join("\n") };
  } finally {
    Object.assign(console, originals);
  }
}
