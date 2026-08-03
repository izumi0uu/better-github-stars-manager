declare const candidateSetTokenBrand: unique symbol;

export type CandidateSetToken = string & {
  readonly [candidateSetTokenBrand]: 'CandidateSetToken';
};

export const CANDIDATE_SET_TOKEN_PREFIX = 'candidate:v1:';

export function parseCandidateSetToken(value: string): CandidateSetToken {
  if (!isCandidateSetToken(value)) {
    throw new TypeError('candidateSetToken must be a nonempty candidate:v1: token.');
  }
  return value;
}

export function isCandidateSetToken(value: unknown): value is CandidateSetToken {
  return (
    typeof value === 'string' &&
    value.startsWith(CANDIDATE_SET_TOKEN_PREFIX) &&
    value.length > CANDIDATE_SET_TOKEN_PREFIX.length
  );
}
