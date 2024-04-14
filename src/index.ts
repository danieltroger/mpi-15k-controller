import util from "util";
import { exec as raw_exec } from "child_process";
import { catchError, createEffect, createRoot } from "solid-js";
import { error } from "./logging";
import { useMQTTValues } from "./useMQTTValues";

while (true) {
  await new Promise<void>(r => {
    createRoot(dispose => {
      catchError(main, e => {
        error("Main crashed, restarting in 10s", e);
        dispose();
        r();
      });
    });
  });
  await new Promise(r => setTimeout(r, 10000));
}

function main() {
  const mqttValues = useMQTTValues();

  createEffect(() => {
    console.log("Values", JSON.parse(JSON.stringify(mqttValues)));
  });
}
