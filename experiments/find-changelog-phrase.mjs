// Prints which comment lines trip the local no-changelog-comments rule.
import fs from 'node:fs';
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const patterns = [
  /\b(?:previously|formerly|used to|no longer|once|originally)\b[\s\S]{0,40}?\b(?:was|were|is|are|did|do|does|had|has|have|used|use|uses|call(?:s|ed)?|name[ds]?|return(?:s|ed)?|live[ds]?|work(?:s|ed)?)\b/iu,
  /\b(?:after the fix|as before|back-compat(?:ible|ibility)?|backwards compat(?:ible|ibility)?)\b/iu,
  /\b(?:instead of|rather than)\b/iu,
  /\b(?:changed|renamed|moved|moved out|switched|migrated|replaced)\b[\s\S]{0,30}?\b(?:from|to|out)\b/iu,
  /\bnow\b[\s\S]{0,30}?\b(?:uses?|does|is|are|returns?|lives?|points?|goes?)\b[\s\S]{0,30}?\b(?:instead|no longer|rather)\b/iu,
  /\b(?:PR|issue|pull request)\s*#\d+/iu,
];
for (const m of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm)) {
  for (const p of patterns) {
    const hit = p.exec(m[0]);
    if (hit) {
      console.log(JSON.stringify(hit[0]));
    }
  }
}
