import { Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { ConfigEditor } from "~/components/ConfigEditor";

export default function Config() {
  return (
    <main>
      <Title>Config editor</Title>
      <A href="/">Back</A>
      <ConfigEditor />
    </main>
  );
}
