// Wire-shared types for the Ah (coulomb-counting) SOC ledger. Pure (no runtime imports, no Node
// built-ins) so the frontend — which has no @types/node — can import `LedgerAnchor` for the
// `latestAnchor` ws value while the backend uses the same definition (CLAUDE.md: shared, never duplicated).

export type AnchorType = "full" | "empty" | "soft_empty";

/** An anchor event the Ah ledger can hang off: when it happened, the SOC it pins, and its kind. */
export type LedgerAnchor = { at: number; soc: number; type: AnchorType };
