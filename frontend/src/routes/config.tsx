import { Title } from "@solidjs/meta";
import { ConfigEditor } from "~/components/ConfigEditor";

export default function Config() {
  return (
    <main>
      <Title>Config editor</Title>
      <h1>Config editor</h1>
      <ConfigEditor />
    </main>
  );
}
