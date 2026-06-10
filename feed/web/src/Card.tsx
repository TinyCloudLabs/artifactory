import { marked } from "marked";
import type { FeedCard } from "../../src/types.ts";

marked.setOptions({ gfm: true, breaks: false });

/** 2-letter type codes, pulse-radio style. Unknown types get initials. */
export function typeCode(type: string): string {
  const known: Record<string, string> = {
    "insight-card": "IC",
    article: "AR",
    podcast: "PC",
  };
  const k = known[type];
  if (k) return k;
  const parts = type.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return type.slice(0, 2).toUpperCase() || "??";
}

export function cardHref(card: FeedCard): string {
  return `#/a/${encodeURIComponent(card.type)}/${encodeURIComponent(card.slug)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function md(text: string): string {
  return marked.parse(text, { async: false });
}

/** First markdown paragraph, for article excerpts on the card face. */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/).find((p) => p.trim()) ?? text;
}

function Body({ text }: { text: string }) {
  return <div className="card-body" dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

function AudioPlayer({ src }: { src: string }) {
  return (
    <div className="card-audio">
      <div className="card-audio-label">&#9654; EPISODE.PLAY</div>
      <audio controls preload="metadata" src={src} />
    </div>
  );
}

function QuoteBlock({ card }: { card: FeedCard }) {
  if (!card.quote) return null;
  return (
    <>
      <blockquote className="card-quote">&ldquo;{card.quote}&rdquo;</blockquote>
      {card.attribution && (
        <div className="card-attribution">-- {card.attribution.toUpperCase()}</div>
      )}
    </>
  );
}

function Tags({
  card,
  activeTag,
  onTagFilter,
}: {
  card: FeedCard;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
}) {
  if (card.tags.length === 0) return null;
  return (
    <div className="card-tags">
      {card.tags.map((t) => {
        const active = activeTag === t;
        return (
          <button
            key={t}
            type="button"
            className={`card-tag${active ? " active" : ""}`}
            onClick={() => onTagFilter(active ? null : t)}
          >
            [{t.toUpperCase()}]
          </button>
        );
      })}
    </div>
  );
}

function Foot({ card }: { card: FeedCard }) {
  const q = card.quality;
  return (
    <div className="card-foot">
      <span>
        {q ? (
          <>
            {q.critic_pass ? "✓" : "✗"}CRITIC {q.quotes_verified ? "✓" : "✗"}
            QUOTES
          </>
        ) : (
          "UNGRADED"
        )}
      </span>
      <span>{card.generation_model?.toUpperCase() ?? ""}</span>
    </div>
  );
}

export function Card({
  card,
  idx,
  activeTag,
  onTagFilter,
}: {
  card: FeedCard;
  idx: number;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
}) {
  const isArticle = card.type === "article";
  const body = card.body
    ? isArticle
      ? firstParagraph(card.body)
      : card.body
    : undefined;

  return (
    <article className="chassis">
      {card.hero_image_url && (
        <div className="card-hero">
          <div className="card-hero-frame">
            <img
              src={card.hero_image_url}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(e) => {
                const wrap = e.currentTarget.closest(".card-hero") as HTMLElement | null;
                if (wrap) wrap.style.display = "none";
              }}
            />
          </div>
        </div>
      )}
      <div className="screen">
        <div className="card-meta">
          <span>
            <span className="dot">&#9679;</span> A{String(idx).padStart(2, "0")}.
            {typeCode(card.type)}
          </span>
          <span>{fmtDate(card.generated_at).toUpperCase()}</span>
        </div>

        <h2 className="card-headline">
          {isArticle ? <a href={cardHref(card)}>{card.headline}</a> : card.headline}
        </h2>

        <QuoteBlock card={card} />
        {body && <Body text={body} />}
        {isArticle && card.body && (
          <a className="read-full" href={cardHref(card)}>
            &gt;&gt; READ FULL ARTICLE
          </a>
        )}
        {card.audio_url && <AudioPlayer src={card.audio_url} />}
        <Tags card={card} activeTag={activeTag} onTagFilter={onTagFilter} />
        <Foot card={card} />
      </div>
    </article>
  );
}

/** Full-page view for an article (or any card opened directly). */
export function FullCard({ card }: { card: FeedCard }) {
  return (
    <article className="chassis article">
      {card.hero_image_url && (
        <div className="card-hero">
          <div className="card-hero-frame">
            <img src={card.hero_image_url} alt="" decoding="async" />
          </div>
        </div>
      )}
      <div className="screen">
        <div className="card-meta">
          <span>
            <span className="dot">&#9679;</span> {typeCode(card.type)}.FULL
          </span>
          <span>{fmtDate(card.generated_at).toUpperCase()}</span>
        </div>
        <h1 className="card-headline" style={{ fontSize: 17 }}>
          {card.headline}
        </h1>
        <QuoteBlock card={card} />
        {card.body && <Body text={card.body} />}
        {card.audio_url && <AudioPlayer src={card.audio_url} />}
        {card.tags.length > 0 && (
          <div className="card-tags">
            {card.tags.map((t) => (
              <span key={t} className="card-tag">
                [{t.toUpperCase()}]
              </span>
            ))}
          </div>
        )}
        <Foot card={card} />
      </div>
    </article>
  );
}
