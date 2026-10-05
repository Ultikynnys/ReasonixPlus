import { vi } from "vitest";

// Only the icons actually imported from "lucide-react" today:
// Markdown.tsx (Check, Copy, ExternalLink, FileText) and ui/thread.tsx (Copy).
export const Check = vi.fn(() => null);
export const Copy = vi.fn(() => null);
export const ExternalLink = vi.fn(() => null);
export const FileText = vi.fn(() => null);
