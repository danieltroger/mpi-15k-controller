import { Title } from "@solidjs/meta";
import { ConfigEditor } from "~/components/configEditor/ConfigEditor";

export default function Config() {
  return (
    <main>
      <Title>Config — Kraftverket</Title>
      <h1>Config</h1>
      <ConfigEditor />
    </main>
  );
}
