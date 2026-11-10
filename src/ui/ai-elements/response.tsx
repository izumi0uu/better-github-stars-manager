import { Streamdown, type StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';

const passiveElements = ['img', 'iframe', 'video', 'audio', 'object', 'embed', 'svg', 'math', 'script', 'style', 'source', 'track'];

function safeReplyUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function MessageResponse({ className, ...props }: StreamdownProps) {
  return (
    <Streamdown
      {...props}
      mode="static"
      animated={false}
      controls={false}
      lineNumbers={false}
      skipHtml
      disallowedElements={passiveElements}
      urlTransform={safeReplyUrl}
      className={cn('bgsm-agent-response', className)}
    />
  );
}
