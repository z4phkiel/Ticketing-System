"""Stage 1 duplicate detection: word-overlap (Jaccard) similarity."""
import re

STOP_WORDS = set("""
a an and are as at be been but by can could do does for from had has have hi hello how i i'm if in
is it its just me my no not of on or our please so that the their them then there this to too was
we were what when where which who why will with would you your thanks thank help issue problem
""".split())


def tokens(text):
    return {w for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in STOP_WORDS and len(w) > 1}


def jaccard(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def find_candidates(subject, body, tickets, min_score, limit=5):
    """Return [(ticket, score)] for the most similar tracked tickets, best first.

    Closed and AI-answered tickets are skipped: a repeat FAQ question should get the instant
    answer again, not be linked as a duplicate. Duplicates are skipped so links point to originals.
    """
    new = tokens(f"{subject} {body}")
    scored = []
    for t in tickets:
        if t.get("status") in ("closed", "ai_resolved") or t.get("duplicate_of"):
            continue
        score = jaccard(new, tokens(f"{t['subject']} {t['body']}"))
        if score >= min_score:
            scored.append((t, round(score, 3)))
    scored.sort(key=lambda p: p[1], reverse=True)
    return scored[:limit]
