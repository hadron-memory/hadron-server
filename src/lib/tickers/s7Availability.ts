/**
 * S7a is INERT until S7b and S5 are wired (Ada #25399): standby and isolation cannot be turned on, and the standby
 * predicate answers "not on standby" whatever a row says. The mechanism (classifier, admission, held-range identity) stays
 * in the tree behind this one gate. S7b removes it in the same change that wires the same-transaction transition and the
 * canonical lockset.
 */
let available = false;

export const s7Available = (): boolean => available;

/** Tests of the inert mechanism only. Production never calls this. */
export function setS7AvailableForTest(v: boolean): void {
  available = v;
}
