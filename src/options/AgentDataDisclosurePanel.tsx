import { Check, ChevronDown, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import { Spinner } from '@/ui/shadcn/spinner';

export function AgentDataDisclosurePanel({
  providerLabel,
  canonicalOrigin,
  customHostAccessRequired,
  hostAccessGranted,
  hostAccessBusy,
  onGrantAccess,
}: {
  providerLabel: string;
  canonicalOrigin: string;
  customHostAccessRequired: boolean;
  hostAccessGranted: boolean;
  hostAccessBusy: boolean;
  onGrantAccess: () => void;
}) {
  const { m } = useI18n();

  return (
    <section
      className="rounded-md border border-border bg-background"
      aria-labelledby="agent-data-disclosure-heading"
      data-testid="agent-data-disclosure"
    >
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2 p-3 [&::-webkit-details-marker]:hidden">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
          <div className="min-w-0 flex-1">
            <h3
              id="agent-data-disclosure-heading"
              className="text-sm font-medium text-foreground"
            >
              {m.options.agentDisclosureHeading}
            </h3>
            <p className="gsm-body-note mt-0.5 break-words">
              {m.options.agentDisclosureIntro(providerLabel, canonicalOrigin)}
            </p>
          </div>
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
        </summary>

        <div className="grid gap-3 border-t border-border px-3 pb-3 pt-2">
          <DisclosureCategoryList
            heading={m.options.agentDisclosureSentHeading}
            items={[
              [[
                'prompt_or_bounded_task_instruction',
                'selected_or_frozen_scope_public_repository_metadata',
                'visible_bounded_tag_taxonomy',
              ], m.options.agentDisclosureSentPrompt],
              [[
                'selected_or_frozen_scope_public_repository_code_snippets',
                'selected_or_frozen_scope_private_notes',
              ], m.options.agentDisclosureSentCode],
              [['protocol_observations'], m.options.agentDisclosureSentProtocol],
            ]}
          />
          <DisclosureCategoryList
            heading={m.options.agentDisclosureNotSentHeading}
            items={[
              [[
                'credentials_or_secrets',
                'github_token',
                'unrelated_or_out_of_scope_stars',
              ], m.options.agentDisclosureNotSentSecrets],
            ]}
          />

          <p className="gsm-body-note">{m.options.agentDisclosureKeyException}</p>
          <p className="gsm-body-note">{m.options.agentDisclosureLocalHistory}</p>
          <p className="gsm-body-note">
            {customHostAccessRequired
              ? m.options.agentDisclosureCustomAccess
              : m.options.agentDisclosureBuiltInAccess}
          </p>
        </div>
      </details>

      {customHostAccessRequired && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          {hostAccessGranted ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-success" role="status">
              <Check className="size-4" />
              {m.options.agentAccessGranted}
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onGrantAccess}
              disabled={hostAccessBusy}
            >
              {hostAccessBusy && <Spinner data-icon="inline-start" />}
              {m.options.agentGrantAccess}
            </Button>
          )}
          {!hostAccessGranted && (
            <p className="text-xs text-warning">{m.options.agentHostAccessRequired}</p>
          )}
        </div>
      )}
    </section>
  );
}

function DisclosureCategoryList({
  heading,
  items,
}: {
  heading: string;
  items: readonly (readonly [categories: readonly string[], label: string])[];
}) {
  return (
    <div>
      <h4 className="text-xs font-medium text-foreground">{heading}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
        {items.map(([categories, label]) => (
          <li key={categories.join(':')} data-disclosure-category={categories.join(' ')}>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
