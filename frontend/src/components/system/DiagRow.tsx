import "./DiagnosticsCards.scss";

/** One label/value line of a diagnostics card. */
export function DiagRow(props: { label: string; value: string; title?: string }) {
  return (
    <div class="diag__row" title={props.title}>
      <span class="diag__label">{props.label}</span>
      <span class="diag__value">{props.value}</span>
    </div>
  );
}
