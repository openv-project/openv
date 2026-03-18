import type { SystemComponent } from "./mod.ts";

export const DOM_NAMESPACE = "party.openv.dom" as const;
export const DOM_NAMESPACE_VERSIONED = `${DOM_NAMESPACE}/0.1.0` as const;

export const VDOM_NAMESPACE = "party.openv.dom.virtual" as const;
export const VDOM_NAMESPACE_VERSIONED = `${VDOM_NAMESPACE}/0.1.0` as const;

export interface DOMComponent extends SystemComponent<typeof DOM_NAMESPACE_VERSIONED, typeof DOM_NAMESPACE> {

  ["party.openv.dom.listRoots"](): Promise<string[]>;

  ["party.openv.dom.getRootInfo"](rootId: string): Promise<{
    title: string;
    url?: string;
    mounted: boolean;
  } | null>;

  ["party.openv.dom.watchRoots"](): Promise<{
    changes: AsyncIterable<{
      type: "attached" | "detached" | "updated";
      rootId: string;
    }>;
    abort: () => Promise<void>;
  }>;

  ["party.openv.dom.getDocumentElement"](rootId: string): Promise<number | null>;

  ["party.openv.dom.query"](
    rootId: string,
    selector: string
  ): Promise<number[]>;

  ["party.openv.dom.getParent"](nodeId: number): Promise<number | null>;

  ["party.openv.dom.getChildren"](nodeId: number): Promise<number[]>;

  ["party.openv.dom.isMounted"](nodeId: number): Promise<boolean>;

  ["party.openv.dom.getNodeType"](nodeId: number): Promise<
    "ELEMENT" | "TEXT" | "COMMENT" | "DOCUMENT"
  >;

  ["party.openv.dom.getTagName"](nodeId: number): Promise<string | null>;

  ["party.openv.dom.getText"](nodeId: number): Promise<string | null>;

  ["party.openv.dom.getAttributes"](nodeId: number): Promise<Record<string, string>>;

  ["party.openv.dom.createElement"](
    rootId: string,
    tagName: string
  ): Promise<number>;

  ["party.openv.dom.createTextNode"](
    rootId: string,
    text: string
  ): Promise<number>;

  ["party.openv.dom.appendChild"](
    parentId: number,
    childId: number
  ): Promise<void>;

  ["party.openv.dom.removeNode"](
    nodeId: number
  ): Promise<void>;

  ["party.openv.dom.setAttribute"](
    nodeId: number,
    name: string,
    value: string
  ): Promise<void>;

  ["party.openv.dom.setText"](
    nodeId: number,
    text: string
  ): Promise<void>;

  ["party.openv.dom.watchNode"](
    nodeId: number
  ): Promise<{
    changes: AsyncIterable<{
      type: "attributes" | "childList" | "characterData";
    }>;
    abort: () => Promise<void>;
  }>;
}

export interface VDOMComponent extends SystemComponent<typeof VDOM_NAMESPACE_VERSIONED, typeof VDOM_NAMESPACE> {
  ["party.openv.dom.virtual.create"](rootId: string): Promise<number>;

  ["party.openv.dom.virtual.destroy"](rootId: number): Promise<void>;

  ["party.openv.dom.virtual.onGetRootInfo"](rootId: string, handler: () => Promise<{
    title: string;
    url?: string;
    mounted: boolean;
  } | null>): Promise<void>;

  ["party.openv.dom.virtual.onGetDocumentElement"](rootId: string, handler: (nodeId: number) => Promise<number | null>): Promise<void>;
  
  ["party.openv.dom.virtual.onQuery"](rootId: string, handler: (selector: string) => Promise<number[]>): Promise<void>;

  ["party.openv.dom.virtual.onGetParent"](rootId: string, handler: (nodeId: number) => Promise<number | null>): Promise<void>;
  
  ["party.openv.dom.virtual.onGetChildren"](rootId: string, handler: (nodeId: number) => Promise<number[]>): Promise<void>;

  ["party.openv.dom.virtual.onIsMounted"](rootId: string, handler: (nodeId: number) => Promise<boolean>): Promise<void>;

  ["party.openv.dom.virtual.onGetNodeType"](rootId: string, handler: (nodeId: number) => Promise<
    "ELEMENT" | "TEXT" | "COMMENT" | "DOCUMENT"
  >): Promise<void>;

  ["party.openv.dom.virtual.onGetTagName"](rootId: string, handler: (nodeId: number) => Promise<string | null>): Promise<void>;

  ["party.openv.dom.virtual.onGetText"](rootId: string, handler: (nodeId: number) => Promise<string | null>): Promise<void>;

  ["party.openv.dom.virtual.onGetAttributes"](rootId: string, handler: (nodeId: number) => Promise<Record<string, string>>): Promise<void>;

  ["party.openv.dom.virtual.onCreateElement"](rootId: string, handler: (tagName: string) => Promise<number>): Promise<void>;

  ["party.openv.dom.virtual.onCreateTextNode"](rootId: string, handler: (text: string) => Promise<number>): Promise<void>;

  ["party.openv.dom.virtual.onAppendChild"](rootId: string, handler: (parentId: number, childId: number) => Promise<void>): Promise<void>;

  ["party.openv.dom.virtual.onRemoveNode"](rootId: string, handler: (nodeId: number) => Promise<void>): Promise<void>;

  ["party.openv.dom.virtual.onSetAttribute"](rootId: string, handler: (nodeId: number, name: string, value: string) => Promise<void>): Promise<void>;

  ["party.openv.dom.virtual.onSetText"](rootId: string, handler: (nodeId: number, text: string) => Promise<void>): Promise<void>;

  ["party.openv.dom.virtual.onWatchNode"](rootId: string, handler: (nodeId: number) => Promise<{
    changes: AsyncIterable<{
      type: "attributes" | "childList" | "characterData";
    }>;
    abort: () => Promise<void>;
  }>): Promise<void>;
}