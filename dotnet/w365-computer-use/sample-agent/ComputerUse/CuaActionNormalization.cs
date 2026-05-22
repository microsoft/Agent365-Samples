// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Normalizes argument values produced by the OpenAI computer-use model into the shapes the
/// W365 MCP server expects. The OpenAI model emits W3C-flavored names (e.g. <c>ArrowDown</c>,
/// <c>Control</c>, <c>Escape</c>); W365's <c>press_keys</c> rejects those with
/// "Unknown key name" errors. OpenAI's own CUA docs recommend a client-side normalization
/// helper for exactly this:
/// https://developers.openai.com/api/docs/guides/tools-computer-use#3-run-every-returned-action
/// </summary>
internal static class CuaActionNormalization
{
    /// <summary>
    /// Map of OpenAI / W3C key-name aliases (lowercased) to the canonical name accepted by
    /// the W365 <c>press_keys</c> tool. Single characters (letters, digits, punctuation) are
    /// passed through unchanged after lowercasing.
    /// </summary>
    private static readonly Dictionary<string, string> KeyAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        // Arrow keys — the bug that surfaced in the field. OpenAI emits "ArrowDown" etc.;
        // W365 wants the bare direction.
        ["arrowup"]    = "up",
        ["arrowdown"]  = "down",
        ["arrowleft"]  = "left",
        ["arrowright"] = "right",

        // Modifiers
        ["ctrl"]    = "ctrl",
        ["control"] = "ctrl",
        ["option"]  = "alt",
        ["alt"]     = "alt",
        ["shift"]   = "shift",
        ["meta"]    = "win",
        ["cmd"]     = "win",
        ["command"] = "win",
        ["win"]     = "win",
        ["windows"] = "win",
        ["super"]   = "win",

        // Whitespace / editing
        ["return"]    = "enter",
        ["enter"]     = "enter",
        ["esc"]       = "escape",
        ["escape"]    = "escape",
        ["backspace"] = "backspace",
        ["bksp"]      = "backspace",
        ["delete"]    = "delete",
        ["del"]       = "delete",
        ["tab"]       = "tab",
        ["space"]     = "space",
        [" "]         = "space",

        // Navigation
        ["home"]     = "home",
        ["end"]      = "end",
        ["pageup"]   = "page_up",
        ["pgup"]     = "page_up",
        ["pagedown"] = "page_down",
        ["pgdn"]    = "page_down",
        ["insert"]   = "insert",
        ["ins"]      = "insert",

        // Locks
        ["capslock"]   = "capslock",
        ["numlock"]    = "numlock",
        ["scrolllock"] = "scrolllock",

        // Print / pause / context
        ["printscreen"] = "printscreen",
        ["prtsc"]       = "printscreen",
        ["pause"]       = "pause",
        ["contextmenu"] = "menu",

        // Function keys F1..F24 — populated below
    };

    static CuaActionNormalization()
    {
        for (var i = 1; i <= 24; i++)
        {
            KeyAliases[$"f{i}"] = $"f{i}";
        }
    }

    /// <summary>
    /// Normalize a single key name from the OpenAI/W3C convention to the W365 convention.
    /// Unknown keys are passed through lowercased so unmapped single-character keys
    /// (letters, digits, punctuation) keep working.
    /// </summary>
    public static string NormalizeKey(string key)
    {
        if (string.IsNullOrEmpty(key)) return key;

        var lower = key.Trim().ToLowerInvariant();
        return KeyAliases.TryGetValue(lower, out var mapped) ? mapped : lower;
    }

    /// <summary>
    /// Normalize an array of key names. Useful when forwarding the model's <c>keys</c> array
    /// directly to <c>press_keys</c>.
    /// </summary>
    public static string[] NormalizeKeys(IEnumerable<string> keys) =>
        keys.Select(NormalizeKey).ToArray();

    /// <summary>
    /// Normalize a mouse-button name. OpenAI emits lowercase
    /// <c>left | right | middle | wheel | back | forward</c>; W365 expects PascalCase
    /// <c>Left | Right | Middle</c>. <c>wheel</c> is treated as <c>Middle</c>; the X-buttons
    /// (<c>back</c>/<c>forward</c>) are not currently dispatched by the orchestrator and are
    /// passed through as the model emitted them so any future server support surfaces a
    /// clear error rather than silent substitution.
    /// </summary>
    public static string NormalizeMouseButton(string? button)
    {
        if (string.IsNullOrEmpty(button)) return "Left";
        var lower = button.Trim().ToLowerInvariant();
        return lower switch
        {
            "left"   => "Left",
            "right"  => "Right",
            "middle" or "wheel" => "Middle",
            _ => char.ToUpperInvariant(lower[0]) + lower[1..]
        };
    }
}
