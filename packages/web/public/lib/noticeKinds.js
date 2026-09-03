/**
 * How a notice reads on a card.
 *
 * The office raises three kinds of notice and each one asks the crew for
 * something different — so the word on the card is not decoration, it is the
 * instruction. Getting it wrong sends someone to do the opposite of what the
 * office decided.
 *
 * This lives in its own file, with no DOM in it, so `notice-kinds.test.js` can
 * import it and check it covers every kind the domain can raise. The card used
 * to decide the wording itself, by branching on `notice.status` — which is the
 * lifecycle (Active / Resolved / Superseded), never the decision. Every live
 * notice took the else, so a REJECTED notice, the one meaning "nobody is
 * sourcing this, go and find it", read to the crew as "Returned".
 *
 * Only the label and the styling belong here. The sentence itself comes from
 * the server, which writes it in `domain/notices.js` with the quantity and the
 * office's own note already folded in.
 */

export const NOTICE_KINDS = Object.freeze({
  REJECTED: { label: 'Rejected', className: 'notice-rejected' },
  RETURNED: { label: 'Returned', className: '' },
  CONFIRMED: { label: 'On order', className: 'notice-ok' }
});

/** How to render one notice. Unknown kinds show their own name rather than nothing. */
export const noticeKind = (kind) =>
  NOTICE_KINDS[kind] ?? { label: String(kind ?? 'Notice'), className: '' };
