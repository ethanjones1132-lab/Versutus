"""Speakable replies: the reader hears words, never markdown (bar row U6)."""

from versutus_voice.speakable import CODE_NOTE, speakable
from versutus_voice.tts import SpeechSynthesizer


def _synth(text):
    return [text.encode("ascii")]


def test_a_fenced_block_becomes_a_short_spoken_note():
    out = speakable("Before.\n```python\nprint('x')\n```\nAfter.")
    assert out == f"Before. {CODE_NOTE} After."
    assert "print" not in out
    assert "```" not in out


def test_an_unclosed_fence_is_dropped_instead_of_read_out():
    out = speakable("Try this:\n```python\nprint('x')")
    assert out == f"Try this: {CODE_NOTE}"
    assert "```" not in out


def test_inline_code_keeps_its_words_and_loses_its_backticks():
    assert speakable("Run `npm test` now.") == "Run npm test now."
    assert speakable("Use ``git status`` first.") == "Use git status first."


def test_a_link_is_spoken_as_its_label():
    assert speakable("See [the docs](https://example.com/docs) for this.") == (
        "See the docs for this."
    )


def test_an_image_is_spoken_as_its_alt_text():
    assert speakable("![a cat](cat.png) sat down.") == "a cat sat down."


def test_a_bare_url_becomes_a_link_and_keeps_its_full_stop():
    assert speakable("See https://example.com/a for details.") == (
        "See a link for details."
    )
    assert speakable("Go to www.example.com now.") == "Go to a link now."
    # Even a scheme with no host left behind must not be spelled out.
    assert speakable("Open https:// now.") == "Open a link now."


def test_an_autolink_keeps_its_words_and_loses_the_angle_brackets():
    assert speakable("Read <https://example.com> now.") == "Read a link now."


def test_emphasis_markers_are_not_spoken():
    assert speakable("This is **bold**, *italic*, _also italic_ and ~~gone~~.") == (
        "This is bold, italic, also italic and gone."
    )
    assert speakable("This is __strong__ too.") == "This is strong too."
    # An identifier's underscores are part of the word, not emphasis markers.
    assert speakable("Call save_user_name first.") == "Call save_user_name first."


def test_heading_markers_are_not_spoken():
    assert speakable("# Title") == "Title"
    assert speakable("### Sub ##") == "Sub"


def test_list_markers_are_not_spoken():
    assert speakable("- one\n- two") == "one two"
    assert speakable("1. first\n2. second") == "first second"
    assert speakable("- [ ] todo\n- [x] done") == "todo done"


def test_blockquote_markers_are_not_spoken():
    assert speakable("> quoted\n> > nested") == "quoted nested"


def test_table_markers_are_not_spoken():
    table = "| Name | Value |\n| --- | --- |\n| A | 1 |"
    assert speakable(table) == "Name Value A 1"


def test_whitespace_is_collapsed():
    # The inside collapses; a chunk's edges are kept, since streamed deltas meet there.
    assert speakable("One   two\n\nthree\tfour ") == "One two three four "
    assert speakable(" One. ") == " One. "


def test_plain_text_is_unchanged():
    assert speakable("One. Two! Three?") == "One. Two! Three?"


def test_a_mixed_reply_is_wholly_speakable():
    reply = (
        "Here's the fix for **the crash**:\n\n"
        "```python\nprint('hi')\n```\n\n"
        "Run `npm test`, then read [the docs](https://example.com/docs).\n\n"
        "> It is quick.\n\n"
        "| Step | Time |\n"
        "| --- | --- |\n"
        "| Build | 2 s |\n\n"
        "- Done."
    )
    expected = (
        f"Here's the fix for the crash: {CODE_NOTE} "
        "Run npm test, then read the docs. "
        "It is quick. Step Time Build 2 s Done."
    )
    out = speakable(reply)
    assert out == expected
    assert "```" not in out
    assert "http://" not in out
    assert "https://" not in out


def test_speak_cleans_the_reply_before_kokoro_sees_it():
    tts = SpeechSynthesizer(_synth)
    chunks = [
        pcm.decode()
        for _gen, pcm in tts.speak(
            "Run `npm test`. See [the docs](https://example.com).", gen=1
        )
    ]
    assert chunks == ["Run npm test. ", "See the docs."]
