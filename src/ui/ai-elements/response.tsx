import { Streamdown, type StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';

export function MessageResponse({ className, ...props }: StreamdownProps) {
  return (
    <Streamdown
      mode="static"
      animated={false}
      controls={false}
      lineNumbers={false}
      skipHtml
      className={cn('bgsm-agent-response', className)}
      {...props}
    />
  );
}
