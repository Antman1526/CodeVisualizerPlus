import {
  FlowchartIR,
  FlowchartNode,
  FlowchartEdge,
  NodeType,
  LocationMapEntry,
} from "../../../ir/ir";

interface MarkdownHeading {
  level: number;
  text: string;
  id: string;
  start: number;
  end: number;
}

interface MarkdownLink {
  text: string;
  url: string;
  start: number;
  end: number;
  headingId: string | null;
}

/**
 * Analyzes a Markdown document and produces a FlowchartIR representing:
 * - The heading hierarchy (H1 → H2 → H3 etc.) as a tree
 * - Outbound links extracted from each section as dashed edges
 */
export function analyzeMarkdownContent(sourceCode: string): FlowchartIR {
  const headings = extractHeadings(sourceCode);
  const links = extractLinks(sourceCode, headings);
  return buildFlowchartIR(sourceCode, headings, links);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const id = `h${level}_${sanitizeId(text)}_${i}`;
      headings.push({
        level,
        text,
        id,
        start: offset,
        end: offset + line.length,
      });
    }
    offset += line.length + 1; // +1 for the newline character
  }

  return headings;
}

function extractLinks(
  content: string,
  headings: MarkdownHeading[]
): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  // Match [text](url) – skip image links that start with !
  const linkRegex = /(?<!\!)\[([^\]]+)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(content)) !== null) {
    const text = match[1];
    const url = match[2];
    const start = match.index;
    const end = match.index + match[0].length;

    // Find the innermost heading whose start is before this link
    let headingId: string | null = null;
    for (let i = headings.length - 1; i >= 0; i--) {
      if (headings[i].start <= start) {
        headingId = headings[i].id;
        break;
      }
    }

    links.push({ text, url, start, end, headingId });
  }

  return links;
}

// ---------------------------------------------------------------------------
// ID sanitisation
// ---------------------------------------------------------------------------

function sanitizeId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 30) || "node";
}

// ---------------------------------------------------------------------------
// FlowchartIR builder
// ---------------------------------------------------------------------------

function buildFlowchartIR(
  content: string,
  headings: MarkdownHeading[],
  links: MarkdownLink[]
): FlowchartIR {
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];
  const locationMap: LocationMapEntry[] = [];

  // --- Heading nodes -------------------------------------------------------

  if (headings.length === 0) {
    // No headings found – show a placeholder root node
    nodes.push({
      id: "doc_root",
      label: "Markdown Document\n(no headings found)",
      shape: "stadium",
      nodeType: NodeType.ENTRY,
    });
  }

  for (const heading of headings) {
    const shapeMap: Record<number, "rect" | "diamond" | "round" | "stadium"> =
      {
        1: "stadium",
        2: "rect",
        3: "round",
        4: "round",
        5: "round",
        6: "round",
      };

    const prefix = "H" + heading.level + " ";
    nodes.push({
      id: heading.id,
      label: prefix + heading.text,
      shape: shapeMap[heading.level] ?? "round",
      nodeType: heading.level === 1 ? NodeType.ENTRY : NodeType.PROCESS,
    });

    locationMap.push({
      nodeId: heading.id,
      start: heading.start,
      end: heading.end,
    });
  }

  // --- Heading hierarchy edges ---------------------------------------------
  // Use a stack to track ancestors and wire parent → child.
  const stack: MarkdownHeading[] = [];
  for (const heading of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      edges.push({ from: stack[stack.length - 1].id, to: heading.id });
    }
    stack.push(heading);
  }

  // --- Link nodes ----------------------------------------------------------
  // De-duplicate URLs; one node per unique URL target.
  const seenUrls = new Set<string>();
  const urlToNodeId = new Map<string, string>();
  let linkCounter = 0;

  for (const link of links) {
    // Skip pure anchor links (e.g. #section-name) – they reference the same doc
    if (link.url.startsWith("#")) {
      continue;
    }

    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      linkCounter++;
      const linkId = `link_${sanitizeId(link.url)}_${linkCounter}`;
      urlToNodeId.set(link.url, linkId);

      const isExternal =
        link.url.startsWith("http://") || link.url.startsWith("https://");
      const displayUrl =
        link.url.length > 45 ? link.url.substring(0, 42) + "..." : link.url;
      const labelText =
        link.text.toLowerCase() !== link.url.toLowerCase()
          ? `${link.text}\n[${displayUrl}]`
          : `[${displayUrl}]`;
      const prefix = isExternal ? "🌐 " : "📄 ";

      nodes.push({
        id: linkId,
        label: prefix + labelText,
        shape: "round",
        nodeType: NodeType.FUNCTION_CALL,
      });
    }

    const sourceId =
      link.headingId ?? (nodes.length > 0 ? nodes[0].id : "doc_root");
    const targetId = urlToNodeId.get(link.url);

    if (targetId) {
      // Avoid duplicate edges (multiple links to the same URL from the same heading)
      const alreadyExists = edges.some(
        (e) => e.from === sourceId && e.to === targetId
      );
      if (!alreadyExists) {
        edges.push({
          from: sourceId,
          to: targetId,
          label: "link",
        });
      }
    }
  }

  const entryId =
    headings.length > 0 ? headings[0].id : nodes[0]?.id ?? "doc_root";
  const title = headings.length > 0 ? headings[0].text : "Markdown Document";

  return {
    nodes,
    edges,
    entryNodeId: entryId,
    locationMap,
    // Cover the entire document so cursor movement doesn't retrigger re-renders
    functionRange: { start: 0, end: content.length },
    title,
  };
}
