export type ContentLanguage = "json" | "xml" | "sql" | "plaintext";

export function detectLanguage(value: string): ContentLanguage {
  const s = value.trim();
  if (!s) return "plaintext";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* fallthrough */
    }
  }
  if (s.startsWith("<") && s.endsWith(">") && /<\/?[a-zA-Z]/.test(s)) {
    return "xml";
  }
  if (/^\s*(select|insert|update|delete|with|create|alter|drop)\b/i.test(s)) {
    return "sql";
  }
  return "plaintext";
}

export function tryFormat(value: string, lang: ContentLanguage): string {
  if (lang === "json") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (lang === "xml") {
    return formatXml(value);
  }
  return value;
}

function formatXml(xml: string): string {
  const PADDING = "  ";
  const reg = /(>)(<)(\/*)/g;
  let formatted = xml.replace(reg, "$1\n$2$3");
  let pad = 0;
  return formatted
    .split("\n")
    .map((line) => {
      let indent = 0;
      if (/^<\/.+>/.test(line)) {
        pad -= 1;
      } else if (/^<[^!?][^>]*[^/]>$/.test(line)) {
        indent = 1;
      }
      const padding = PADDING.repeat(Math.max(pad, 0));
      pad += indent;
      return padding + line;
    })
    .join("\n");
}
