// Package langs turns the language tags video files carry into the ones
// manifests and menus want.
package langs

import "strings"

// short maps ISO 639-2 codes, the three-letter tags MP4 and Matroska files
// carry, to the two-letter BCP 47 form manifests use. Both the bibliographic
// and terminology codes are here where they differ (fre and fra, ger and deu).
// The packager would shorten these itself; doing it here makes folder names
// and the database agree with the manifests.
var short = map[string]string{
	"eng": "en", "vie": "vi", "fra": "fr", "fre": "fr", "spa": "es",
	"deu": "de", "ger": "de", "ita": "it", "por": "pt", "jpn": "ja",
	"kor": "ko", "zho": "zh", "chi": "zh", "tha": "th", "ind": "id",
	"hin": "hi", "ara": "ar", "rus": "ru",
}

// names are each language's name for itself, for menus. RFC 8216 says a
// rendition's NAME SHOULD be in its own language (4.3.4.1): "Tiếng Việt" is
// what a Vietnamese speaker looks for, not "Vietnamese".
var names = map[string]string{
	"en": "English", "vi": "Tiếng Việt", "fr": "Français", "es": "Español",
	"de": "Deutsch", "it": "Italiano", "pt": "Português", "ja": "日本語",
	"ko": "한국어", "zh": "中文", "th": "ไทย", "id": "Bahasa Indonesia",
	"hi": "हिन्दी", "ar": "العربية", "ru": "Русский",
}

// Normalize returns the shortest form of a tag: "eng" becomes "en", "pt-BR"
// stays "pt-BR". "" and "und" (undetermined) both come back as "".
func Normalize(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" || strings.EqualFold(tag, "und") {
		return ""
	}
	base, region, _ := strings.Cut(tag, "-")
	base = strings.ToLower(base)
	if s, ok := short[base]; ok {
		base = s
	}
	if region == "" {
		return base
	}
	return base + "-" + region
}

// Label is the menu name for a track: the file's own title if it has one,
// else the language's name for itself, else the tag.
func Label(tag, title string) string {
	if title = strings.TrimSpace(title); title != "" {
		return title
	}
	tag = Normalize(tag)
	base, _, _ := strings.Cut(tag, "-")
	if name, ok := names[base]; ok {
		return name
	}
	if tag == "" {
		return "Unknown language"
	}
	return tag
}

// Valid reports whether s looks like a language tag: two or three letters,
// then optional subtags such as a region ("pt-BR") or script ("zh-Hant").
// Uploaded subtitle files are named after their language, so this is what
// stands between a filename and a manifest.
func Valid(s string) bool {
	parts := strings.Split(s, "-")
	if len(parts[0]) < 2 || len(parts[0]) > 3 || !letters(parts[0]) {
		return false
	}
	for _, p := range parts[1:] {
		if len(p) < 2 || len(p) > 8 || !alnum(p) {
			return false
		}
	}
	return true
}

func letters(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}

func alnum(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}
