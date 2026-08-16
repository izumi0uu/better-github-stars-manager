import { cn } from '@/lib/utils';
import { useManagerImage } from '@/ui/components/ManagerResource';

const REPOSITORY_AVATAR_COLOR_COUNT = 9;
const REPOSITORY_INITIAL_PATTERN = /[\p{L}\p{N}]/u;

export function repositoryAvatarFallback(fullName: string) {
  const repositoryName = fullName.slice(fullName.lastIndexOf('/') + 1).trim();
  let initial = '#';
  for (const character of repositoryName) {
    if (!REPOSITORY_INITIAL_PATTERN.test(character)) continue;
    initial = character.toUpperCase();
    break;
  }
  let hash = 2166136261;
  for (let index = 0; index < fullName.length; index++) {
    hash ^= fullName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { color: (hash >>> 0) % REPOSITORY_AVATAR_COLOR_COUNT, initial };
}

/**
 * Repository-owner avatar cell shared by Stars, Radar, and Watch surfaces.
 * Falls back to a deterministic colored initial when the URL is missing or
 * the image fails to load.
 */
export function RepositoryOwnerAvatar({
  fullName,
  url,
  className,
}: {
  fullName: string;
  url: string | null | undefined;
  className?: string;
}) {
  const resolvedUrl = useManagerImage({
    kind: 'repository-avatar',
    identity: fullName,
    remoteUrl: url ?? null,
  });
  const fallback = repositoryAvatarFallback(fullName);
  return (
    <span
      data-repository-avatar-slot
      data-avatar-color={fallback.color}
      aria-hidden="true"
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-border',
        className ?? 'size-5',
      )}
    >
      <span
        data-repository-avatar-fallback
        className="gsm-repository-avatar-fallback absolute inset-0 grid place-items-center text-[10px] font-semibold leading-none text-primary-foreground dark:text-background"
      >
        {fallback.initial}
      </span>
      {resolvedUrl ? (
        <img
          key={resolvedUrl}
          data-repository-avatar
          src={resolvedUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </span>
  );
}
