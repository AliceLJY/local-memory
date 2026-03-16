import { z } from "zod";

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedStringSchema(field: string, maxLength: number) {
  return z.string({ required_error: `${field} is required` })
    .transform(collapseWhitespace)
    .pipe(
      z.string()
        .min(1, `${field} is required`)
        .max(maxLength, `${field} must be at most ${maxLength} characters`),
    );
}

export function optionalBoundedStringSchema(maxLength: number) {
  return z.string()
    .transform(collapseWhitespace)
    .pipe(z.string().min(1).max(maxLength))
    .optional();
}

export function identifierSchema(field: string, maxLength = 160) {
  return z.string({ required_error: `${field} is required` })
    .transform(collapseWhitespace)
    .pipe(
      z.string()
        .min(1, `${field} is required`)
        .max(maxLength, `${field} must be at most ${maxLength} characters`),
    );
}

export function normalizedStringListSchema(
  field: string,
  maxItems: number,
  maxItemLength: number,
) {
  return z.array(boundedStringSchema(field, maxItemLength))
    .default([])
    .transform((items) => {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return deduped;
    })
    .pipe(
      z.array(z.string())
        .max(maxItems, `${field} must contain at most ${maxItems} items`),
    );
}
