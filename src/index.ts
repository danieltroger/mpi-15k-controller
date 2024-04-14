import util from "util";
import { exec as raw_exec } from "child_process";
import { catchError, createRoot } from "solid-js";
import { error } from "./logging";
import { useMQTTValues } from "./useMQTTValues";

while (true) {
  await new Promise<void>(r => {
    createRoot(dispose => {
      catchError(main, e => {
        error("Main crashed, restarting in 5s", e);
        dispose();
        r();
      });
    });
  });
  await new Promise(r => setTimeout(r, 5000));
}

function main() {
  const mqttValues = useMQTTValues();
  console.log("hi");
}
