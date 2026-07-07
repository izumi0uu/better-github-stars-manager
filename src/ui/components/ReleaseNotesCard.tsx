import { useState } from 'react';
import { Archive, Check, Columns3, RefreshCw, Sparkles, Tags, X } from 'lucide-react';
import { Button } from '@/ui/shadcn/button';
import { useI18n } from '@/i18n';

export const RELEASE_NOTES_ID = 'release-user-facing-changes-20260706';

const iconClassName = 'size-4';

export function ReleaseNotesCard({
  interactionLocked,
  onDismiss,
}: {
  interactionLocked: boolean;
  onDismiss: () => void;
}) {
  const { m } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const icons = [
    <Columns3 className={iconClassName} aria-hidden="true" />,
    <Archive className={iconClassName} aria-hidden="true" />,
    <Tags className={iconClassName} aria-hidden="true" />,
    <RefreshCw className={iconClassName} aria-hidden="true" />,
  ];

  return (
    <section className="border-b border-border bg-card/80 px-3 py-3 text-sm" aria-labelledby="gsm-release-notes-title">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-primary">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="gsm-release-notes-title" className="text-sm font-semibold text-foreground">
            {m.releaseNotes.title}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {m.releaseNotes.subtitle}
          </p>
        </div>
        <button
          type="button"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          aria-label={m.releaseNotes.dismissTitle}
          title={m.releaseNotes.dismissTitle}
          disabled={interactionLocked}
          onClick={onDismiss}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {m.releaseNotes.cards.map((card, index) => (
          <article
            key={card.title}
            className="min-w-0 rounded-md border border-border bg-background p-3"
          >
            <div className="mb-2 flex items-center gap-2 text-foreground">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-primary">
                {icons[index]}
              </span>
              <h3 className="min-w-0 text-[13px] font-semibold leading-snug">
                {card.title}
              </h3>
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {card.body}
            </p>
          </article>
        ))}
      </div>

      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={interactionLocked}
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? m.releaseNotes.hideDetails : m.releaseNotes.readDetails}
        </Button>
      </div>

      {detailsOpen && (
        <div className="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-3">
          {m.releaseNotes.details.map((section) => (
            <section key={section.title} className="min-w-0">
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-normal text-muted-foreground">
                {section.title}
              </h3>
              <ul className="space-y-2">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
