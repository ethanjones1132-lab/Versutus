"""What Kokoro may read aloud: a chat reply minus its rendering syntax.

Replies are written for a markdown renderer. Read verbatim, that scaffolding
becomes "backtick backtick python", "asterisk asterisk", and a URL spelled out
one character at a time, which is long, confusing and useless over a call
(handsfree bar, U6). A fenced block has no useful spoken content at all, so it
is replaced with a short note that points the listener at the chat instead.

The Gate's splitter only splits sentences; this is the one place the text is
cleaned, before splitting, so Kokoro's pauses still line up with the words it
actually says. The result must never contain a fence or an ``http`` URL.
"""

import re

CODE_NOTE = "I've put the code in the chat."

# Closed fences and an unterminated one that runs to the end both count: a
# dropped closing fence must not leak its code out as speech.
_FENCED = re.compile(r"```[\s\S]*?(?:```|$)")
# ``![alt](src)`` is an image; its alt text is the only speakable part.
_IMAGE_OR_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_AUTOLINK = re.compile(r"<(?:https?://|www\.)[^>]*>", re.IGNORECASE)
_URL = re.compile(r"(?:https?://|www\.)[^\s<>]*", re.IGNORECASE)
# Pairs first: a bold marker matched as italic would leave one asterisk behind.
_EMPHASIS = (
    (re.compile(r"\*\*([^*]+)\*\*"), r"\1"),
    (re.compile(r"__([^_]+)__"), r"\1"),
    (re.compile(r"~~([^~]+)~~"), r"\1"),
    (re.compile(r"\*([^*]+)\*"), r"\1"),
    # Bounded by non-word characters so snake_case identifiers are not
    # mistaken for italics and squashed together.
    (re.compile(r"(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])"), r"\1"),
)
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+")
_HEADING_CLOSE = re.compile(r"\s+#+\s*$")
_QUOTE = re.compile(r"^\s*(?:>\s?)+")
_BULLET = re.compile(r"^\s*[-*+]\s+(?:\[[ xX]\]\s+)?")
_ORDERED = re.compile(r"^\s*\d+[.)]\s+")
_INLINE_CODE = re.compile(r"`+")
_TABLE_SEPARATOR = re.compile(r"^[\s|:-]+$")
_WHITESPACE = re.compile(r"\s+")


def _linked(match):
    """Keep the punctuation that followed a URL, so sentence order survives."""
    url = match.group(0)
    kept = url.rstrip(".,;:!?)]}\"'")
    return "a link" + url[len(kept) :]


def _is_table_separator(line):
    """``|---|---|`` and ``---`` are rules, not words."""
    stripped = line.strip()
    return (
        bool(stripped)
        and "-" in stripped
        and bool(_TABLE_SEPARATOR.match(stripped))
    )


def _plain_lines(text):
    """Drop the markers that live at the start (or edges) of a line."""
    lines = []
    for line in text.splitlines():
        if _is_table_separator(line):
            continue
        line = _QUOTE.sub("", line)
        line = _HEADING.sub("", line)
        line = _HEADING_CLOSE.sub("", line)
        line = _BULLET.sub("", line)
        line = _ORDERED.sub("", line)
        # A table cell boundary is not a pause: keep the words, lose the pipe.
        lines.append(line.replace("|", " "))
    return "\n".join(lines)


def speakable(text):
    """Return ``text`` as plain speech: no fences, markup or raw URLs."""
    if not text:
        return ""
    cleaned = _FENCED.sub(CODE_NOTE, text)
    cleaned = _IMAGE_OR_LINK.sub(r"\1", cleaned)
    cleaned = _AUTOLINK.sub("a link", cleaned)
    cleaned = _URL.sub(_linked, cleaned)
    for pattern, replacement in _EMPHASIS:
        cleaned = pattern.sub(replacement, cleaned)
    cleaned = _plain_lines(cleaned)
    # Inline code keeps its words; the backticks were only a font choice.
    cleaned = _INLINE_CODE.sub("", cleaned)
    # speak() is fed streamed deltas ("One. ", "Two. "): the edges of a chunk
    # are where sentences meet, so they are kept exactly and only the inside
    # is collapsed.
    body = _WHITESPACE.sub(" ", cleaned).strip()
    if not body:
        return ""
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return lead + body + trail
