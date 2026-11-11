package langs

import "testing"

func TestNormalize(t *testing.T) {
	for in, want := range map[string]string{
		"eng": "en", "VIE": "vi", "en": "en", "pt-BR": "pt-BR", "fre": "fr",
		"und": "", "": "", " vie ": "vi", "tlh": "tlh",
	} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLabel(t *testing.T) {
	cases := []struct{ tag, title, want string }{
		{"vie", "", "Tiếng Việt"},
		{"eng", "English 5.1", "English 5.1"},
		{"pt-BR", "", "Português"},
		{"tlh", "", "tlh"},
		{"", "", "Unknown language"},
	}
	for _, c := range cases {
		if got := Label(c.tag, c.title); got != c.want {
			t.Errorf("Label(%q, %q) = %q, want %q", c.tag, c.title, got, c.want)
		}
	}
}

func TestValid(t *testing.T) {
	for s, want := range map[string]bool{
		"en": true, "vie": true, "pt-BR": true, "zh-Hant": true,
		"": false, "e": false, "english": false, "en_US": false, "../x": false, "en-": false,
	} {
		if got := Valid(s); got != want {
			t.Errorf("Valid(%q) = %v, want %v", s, got, want)
		}
	}
}
