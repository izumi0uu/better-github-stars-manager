export type TagDeletionProposal =
  | { kind: 'repository'; changes: { full_name: string; tags: string[] }[] }
  | { kind: 'global'; tags: string[] };

export type TagDeletionReview = {
  id: string;
  sessionId: string;
  proposal: TagDeletionProposal;
};
