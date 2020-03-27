/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';

import { URI } from 'vscode-uri';
import * as SemVer from 'semver';

import * as lsp from 'vscode-languageserver';
import {
	Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult,
	TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge, RangeBasedDocumentSymbol, DeclarationResult, ResultSet,
	ElementTypes, VertexLabels, EdgeLabels, ItemEdgeProperties, EventScope, EventKind, GroupEvent, ProjectEvent, Moniker as PMoniker, moniker, MonikerKind
} from 'lsif-protocol';

import { DocumentInfo } from './files';
import { Database, UriTransformer } from './database';
import { eventNames } from 'cluster';

interface Moniker extends PMoniker {
	key: string;
}

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

type ItemTarget =
	Range |
	{ type: ItemEdgeProperties.declarations; range: Range; } |
	{ type: ItemEdgeProperties.definitions; range: Range; } |
	{ type: ItemEdgeProperties.references; range: Range; } |
	{ type: ItemEdgeProperties.referenceResults; result: ReferenceResult; } |
	{ type: ItemEdgeProperties.referenceLinks; result: Moniker; };

interface Out {
	contains: Map<Id, Document[] | Range[]>;
	item: Map<Id, ItemTarget[]>;
	next: Map<Id, Vertex>;
	moniker: Map<Id, Moniker>;
	documentSymbol: Map<Id, DocumentSymbolResult>;
	foldingRange: Map<Id, FoldingRangeResult>;
	documentLink: Map<Id, DocumentLinkResult>;
	diagnostic: Map<Id, DiagnosticResult>;
	declaration: Map<Id, DeclarationResult>;
	definition: Map<Id, DefinitionResult>;
	typeDefinition: Map<Id, TypeDefinitionResult>;
	hover: Map<Id, HoverResult>;
	references: Map<Id, ReferenceResult>;
	implementation: Map<Id, ImplementationResult>;
}

interface In {
	contains: Map<Id, Project | Document>;
	previous: Map<Id, Vertex>;
	moniker: Map<Id, Vertex>;
}

interface Indices {
	monikers: Map<string, Moniker[]>;
	contents: Map<string, string>;
	documents: Map<string, { hash: string, documents: Document[] }>;
}

export class JsonStore extends Database {

	private version: string | undefined;
	private projectRoot!: URI;
	private activeGroup: Id | undefined;
	private activeProject: Id | undefined;

	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	constructor() {
		super();
		this.vertices = {
			all: new Map(),
			projects: new Map(),
			documents: new Map(),
			ranges: new Map()
		};

		this.indices = {
			contents: new Map(),
			documents: new Map(),
			monikers: new Map(),
		};

		this.out = {
			contains: new Map(),
			item: new Map(),
			next: new Map(),
			moniker: new Map(),
			documentSymbol: new Map(),
			foldingRange: new Map(),
			documentLink: new Map(),
			diagnostic: new Map(),
			declaration: new Map(),
			definition: new Map(),
			typeDefinition: new Map(),
			hover: new Map(),
			references: new Map(),
			implementation: new Map()
		};

		this.in = {
			contains: new Map(),
			previous: new Map(),
			moniker: new Map()
		};
	}

	public load(file: string, transformerFactory: (projectRoot: string) => UriTransformer): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const input: fs.ReadStream = fs.createReadStream(file, { encoding: 'utf8'});
			input.on('error', reject);
			const rd = readline.createInterface(input);
			rd.on('line', (line: string) => {
				if (!line || line.length === 0) {
					return;
				}
				try {
					const element: Edge | Vertex = JSON.parse(line);
					switch (element.type) {
						case ElementTypes.vertex:
							this.processVertex(element);
							break;
						case ElementTypes.edge:
							this.processEdge(element);
							break;
					}
				} catch (error) {
					input.destroy();
					reject(error);
				}
			});
			rd.on('close', () => {
				if (this.projectRoot === undefined) {
					reject(new Error('No project root provided.'));
					return;
				}
				if (this.version === undefined) {
					reject(new Error('No version found.'));
					return;
				} else {
					const semVer = SemVer.parse(this.version);
					if (!semVer) {
						reject(new Error(`No valid semantic version string. The version is: ${this.version}`));
						return;
					}
					const range: SemVer.Range = new SemVer.Range('>0.4.99 <=0.5.0-next.2');
					range.includePrerelease = true;
					if (!SemVer.satisfies(semVer, range)) {
						reject(new Error(`Requires version 0.5.0 or higher but received: ${this.version}`));
						return;
					}
				}
				resolve();
			});
		}).then(() => {
			this.initialize(transformerFactory);
		});
	}

	public getProjectRoot(): URI {
		return this.projectRoot;
	}

	public close(): void {
	}

	private processVertex(vertex: Vertex): void {
		this.vertices.all.set(vertex.id, vertex);
		switch(vertex.label) {
			case VertexLabels.metaData:
				this.version = vertex.version;
				break;
			case VertexLabels.group:
				if (vertex.rootUri !== undefined) {
					this.projectRoot = URI.parse(vertex.rootUri);
				}
				break;
			case VertexLabels.project:
				this.vertices.projects.set(vertex.id, vertex);
				break;
			case VertexLabels.event:
				if (vertex.kind === EventKind.begin) {
					switch (vertex.scope) {
						case EventScope.group:
							this.activeGroup = (vertex as GroupEvent).data;
							break;
						case EventScope.project:
							this.activeProject = (vertex as ProjectEvent).data;
							break;
					}
				}
				break;
			case VertexLabels.document:
				this.doProcessDocument(vertex);
				break;
			case VertexLabels.moniker:
				if (vertex.kind !== MonikerKind.local) {
					const key = crypto.createHash('md5').update(JSON.stringify({ s: vertex.scheme, i: vertex.identifier }, undefined, 0)).digest('base64');
					(vertex as Moniker).key = key;
					let values = this.indices.monikers.get(key);
					if (values === undefined) {
						values = [];
						this.indices.monikers.set(key, values);
					}
					values.push(vertex as Moniker);
				}
				break;
			case VertexLabels.range:
				this.vertices.ranges.set(vertex.id, vertex);
				break;
		}
	}

	private doProcessDocument(document: Document): void {
		const contents = document.contents !== undefined ? document.contents : 'No content provided.';
		this.vertices.documents.set(document.id, document);
		const hash = crypto.createHash('md5').update(contents).digest('base64');
		this.indices.contents.set(hash, contents);

		let value = this.indices.documents.get(document.uri);
		if (value === undefined) {
			value = { hash, documents: [] };
			this.indices.documents.set(document.uri, value);
		}
		if (hash !== value.hash) {
			console.error(`Document ${document.uri} has different content.`);
		}
		value.documents.push(document);
	}

	private processEdge(edge: Edge): void {
		let property: ItemEdgeProperties | undefined;
		if (edge.label === 'item') {
			property = edge.property;
		}
		if (Edge.is11(edge)) {
			this.doProcessEdge(edge.label, edge.outV, edge.inV, property);
		} else if (Edge.is1N(edge)) {
			for (let inV of edge.inVs) {
				this.doProcessEdge(edge.label, edge.outV, inV, property);
			}
		}
	}

	private doProcessEdge(label: EdgeLabels, outV: Id, inV: Id, property?: ItemEdgeProperties): void {
		const from: Vertex | undefined = this.vertices.all.get(outV);
		const to: Vertex | undefined = this.vertices.all.get(inV);
		if (from === undefined) {
			throw new Error(`No vertex found for Id ${outV}`);
		}
		if (to === undefined) {
			throw new Error(`No vertex found for Id ${inV}`);
		}
		let values: any[] | undefined;
		switch (label) {
			case EdgeLabels.contains:
				values = this.out.contains.get(from.id);
				if (values === undefined) {
					values = [ to as any ];
					this.out.contains.set(from.id, values);
				} else {
					values.push(to);
				}
				this.in.contains.set(to.id, from as any);
				break;
			case EdgeLabels.item:
				values = this.out.item.get(from.id);
				let itemTarget: ItemTarget | undefined;
				if (property !== undefined) {
					switch (property) {
						case ItemEdgeProperties.references:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.declarations:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.definitions:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.referenceResults:
							itemTarget = { type: property, result: to as ReferenceResult };
							break;
						case ItemEdgeProperties.referenceLinks:
							itemTarget = { type: property, result: to as Moniker };
					}
				} else {
					itemTarget = to as Range;
				}
				if (itemTarget !== undefined) {
					if (values === undefined) {
						values = [ itemTarget ];
						this.out.item.set(from.id, values);
					} else {
						values.push(itemTarget);
					}
				}
				break;
			case EdgeLabels.next:
				this.out.next.set(from.id, to);
				this.in.previous.set(to.id, from);
				break;
			case EdgeLabels.moniker:
				this.out.moniker.set(from.id, to as Moniker);
				this.in.moniker.set(to.id, from);
				break;
			case EdgeLabels.textDocument_documentSymbol:
				this.out.documentSymbol.set(from.id, to as DocumentSymbolResult);
				break;
			case EdgeLabels.textDocument_foldingRange:
				this.out.foldingRange.set(from.id, to as FoldingRangeResult);
				break;
			case EdgeLabels.textDocument_documentLink:
				this.out.documentLink.set(from.id, to as DocumentLinkResult);
				break;
			case EdgeLabels.textDocument_diagnostic:
				this.out.diagnostic.set(from.id, to as DiagnosticResult);
				break;
			case EdgeLabels.textDocument_definition:
				this.out.definition.set(from.id, to as DefinitionResult);
				break;
			case EdgeLabels.textDocument_typeDefinition:
				this.out.typeDefinition.set(from.id, to as TypeDefinitionResult);
				break;
			case EdgeLabels.textDocument_hover:
				this.out.hover.set(from.id, to as HoverResult);
				break;
			case EdgeLabels.textDocument_references:
				this.out.references.set(from.id, to as ReferenceResult);
				break;
		}
	}

	public getDocumentInfos(): DocumentInfo[] {
		const result: DocumentInfo[] = [];
		this.indices.documents.forEach((value, key) => {
			// We take the id of the first document.
			result.push({ uri: key, id: value.documents[0].id, hash: value.hash });
		});
		return result;
	}

	protected findFile(uri: string): { id: Id; hash: string; } | undefined {
		const result = this.indices.documents.get(uri);
		if (result === undefined) {
			return undefined;
		}
		return { id: result.documents[0].id, hash: result.hash };
	}

	protected fileContent(info: { id: Id, hash: string }): string | undefined {
		return this.indices.contents.get(info.hash);
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		const value = this.indices.documents.get(this.toDatabase(uri));
		if (value === undefined) {
			return undefined;
		}
		// Take the id of the first document with that content. We assume that
		// all documents with the same content have the same folding ranges.
		const id = value.documents[0].id;
		const foldingRangeResult = this.out.foldingRange.get(id);
		if (foldingRangeResult === undefined) {
			return undefined;
		}
		let result: lsp.FoldingRange[] = [];
		for (let item of foldingRangeResult.result) {
			result.push(Object.assign(Object.create(null), item));
		}
		return result;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		const value = this.indices.documents.get(this.toDatabase(uri));
		if (value === undefined) {
			return undefined;
		}
		// Take the id of the first document with that content. We assume that
		// all documents with the same content have the same document symbols.
		const id = value.documents[0].id;
		let documentSymbolResult = this.out.documentSymbol.get(id);
		if (documentSymbolResult === undefined || documentSymbolResult.result.length === 0) {
			return undefined;
		}
		let first = documentSymbolResult.result[0];
		let result: lsp.DocumentSymbol[] = [];
		if (lsp.DocumentSymbol.is(first)) {
			for (let item of documentSymbolResult.result) {
				result.push(Object.assign(Object.create(null), item));
			}
		} else {
			for (let item of (documentSymbolResult.result as RangeBasedDocumentSymbol[])) {
				let converted = this.toDocumentSymbol(item);
				if (converted !== undefined) {
					result.push(converted);
				}
			}
		}
		return result;
	}

	private toDocumentSymbol(value: RangeBasedDocumentSymbol): lsp.DocumentSymbol | undefined {
		let range = this.vertices.ranges.get(value.id)!;
		let tag = range.tag;
		if (tag === undefined || !(tag.type === 'declaration' || tag.type === 'definition')) {
			return undefined;
		}
		let result: lsp.DocumentSymbol = lsp.DocumentSymbol.create(
			tag.text, tag.detail || '', tag.kind,
			tag.fullRange, this.asRange(range)
		);
		if (value.children && value.children.length > 0) {
			result.children = [];
			for (let child of value.children) {
				let converted = this.toDocumentSymbol(child);
				if (converted !== undefined) {
					result.children.push(converted);
				}
			}
		}
		return result;
	}

	public hover(uri: string, position: lsp.Position): lsp.Hover | undefined {
		const range = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined) {
			return undefined;
		}

		const [hoverResult]= this.getResultForId(range.id, this.out.hover);
		if (hoverResult === undefined) {
			return undefined;
		}

		let hoverRange = hoverResult.result.range !== undefined ? hoverResult.result.range : range;
		return {
			contents: hoverResult.result.contents,
			range: hoverRange
		};
	}

	public declarations(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const range = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined) {
			return undefined;
		}
		const [declarationResult] = this.getResultForId(range.id, this.out.declaration);
		if (declarationResult === undefined) {
			return undefined;
		}
		const ranges = this.item(declarationResult);
		if (ranges === undefined) {
			return undefined;
		}
		const result: lsp.Location[] = [];
		for (const element of ranges) {
			result.push(this.asLocation(element));
		}
		return result;
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const range = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined) {
			return undefined;
		}
		const [definitionResult] = this.getResultForId(range.id, this.out.definition);
		if (definitionResult === undefined) {
			return undefined;
		}
		const ranges = this.item(definitionResult);
		if (ranges === undefined) {
			return undefined;
		}
		const result: lsp.Location[] = [];
		for (const element of ranges) {
			result.push(this.asLocation(element));
		}
		return result;
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		let range = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined) {
			return undefined;
		}

		const findReferences = (result: lsp.Location[], dedupRanges: Set<Id>, dedupMonikers: Set<string>, range: Range): void => {
			const [referenceResult, anchorId] = this.getResultForId(range.id, this.out.references);
			if (referenceResult === undefined) {
				return;
			}
			const monikers: Moniker[] = [];
			this.resolveReferenceResult(result, dedupRanges, monikers, referenceResult, context);
			this.findMonikers(monikers, anchorId);
			for (const moniker of monikers) {
				if (dedupMonikers.has(moniker.key)) {
					continue;
				}
				dedupMonikers.add(moniker.key);
				const matchingMonikers = this.indices.monikers.get(moniker.key);
				if (matchingMonikers !== undefined) {
					for (const matchingMoniker of matchingMonikers) {
						if (moniker.id === matchingMoniker.id) {
							continue;
						}
						const vertex = this.findVertexForMoniker(matchingMoniker);
						if (vertex !== undefined) {
							const [referenceResult] = this.getResultForId(vertex.id, this.out.references);
							if (referenceResult === undefined) {
								continue;
							}
							this.resolveReferenceResult(result, dedupRanges, monikers, referenceResult, context);
						}
					}
				}
			}
		};
		const result: lsp.Location[] = [];
		const dedupRanges: Set<Id> = new Set();
		const dedupMonikers: Set<string> = new Set();

		findReferences(result, dedupRanges, dedupMonikers, range);
		return result;
	}

	private getResultForId<T>(id: Id, edges: Map<Id, T>): [T | undefined, Id] {
		let currentId = id;
		do {
			const result: T | undefined = edges.get(currentId);
			if (result !== undefined) {
				return [result, currentId];
			}
			const next = this.out.next.get(id);
			if (next === undefined) {
				return [undefined, id];
			}
			currentId = next.id;
		} while (true);
	}

	private resolveReferenceResult(locations: lsp.Location[], dedupRanges: Set<Id>, monikers: Moniker[], referenceResult: ReferenceResult, context: lsp.ReferenceContext): void {
		const targets = this.item(referenceResult);
		if (targets === undefined) {
			return undefined;
		}
		for (let target of targets) {
			if (target.type === ItemEdgeProperties.declarations && context.includeDeclaration) {
				this.addLocation(locations, target.range, dedupRanges);
			} else if (target.type === ItemEdgeProperties.definitions && context.includeDeclaration) {
				this.addLocation(locations, target.range, dedupRanges);
			} else if (target.type === ItemEdgeProperties.references) {
				this.addLocation(locations, target.range, dedupRanges);
			} else if (target.type === ItemEdgeProperties.referenceResults) {
				this.resolveReferenceResult(locations, dedupRanges, monikers, target.result, context);
			} else if (target.type === ItemEdgeProperties.referenceLinks) {
				monikers.push(target.result);
			}
		}
	}

	private findMonikers(result: Moniker[], id: Id): void {
		let currentId = id;
		do {
			const moniker = this.out.moniker.get(currentId);
			if (moniker !== undefined) {
				result.push(moniker);
				return;
			}
			const previous = this.in.previous.get(id);
			if (previous === undefined) {
				return;
			}
			currentId = previous.id;
		} while (true);
	}

	private findVertexForMoniker(moniker: Moniker): Vertex | undefined {
		return this.in.moniker.get(moniker.id);
	}

	private item(value: DeclarationResult): Range[];
	private item(value: DefinitionResult): Range[];
	private item(value: ReferenceResult): ItemTarget[];
	private item(value: DeclarationResult | DefinitionResult | ReferenceResult): Range[] | ItemTarget[] | undefined {
		if (value.label === 'declarationResult') {
			return this.out.item.get(value.id) as Range[];
		} else if (value.label === 'definitionResult') {
			return this.out.item.get(value.id) as Range[];
		} else if (value.label === 'referenceResult') {
			return this.out.item.get(value.id) as ItemTarget[];
		} else {
			return undefined;
		}
	}

	private asReferenceResult(targets: ItemTarget[], context: lsp.ReferenceContext, dedup: Set<Id>): lsp.Location[] {
		let result: lsp.Location[] = [];
		for (let target of targets) {
			if (target.type === ItemEdgeProperties.declarations && context.includeDeclaration) {
				this.addLocation(result, target.range, dedup);
			} else if (target.type === ItemEdgeProperties.definitions && context.includeDeclaration) {
				this.addLocation(result, target.range, dedup);
			} else if (target.type === ItemEdgeProperties.references) {
				this.addLocation(result, target.range, dedup);
			} else if (target.type === ItemEdgeProperties.referenceResults) {
				result.push(...this.asReferenceResult(this.item(target.result), context, dedup));
			}
		}
		return result;
	}

	private addLocation(result: lsp.Location[], value: Range | lsp.Location, dedup: Set<Id>): void {
		if (lsp.Location.is(value)) {
			result.push(value);
		} else {
			if (dedup.has(value.id)) {
				return;
			}
			let document = this.in.contains.get(value.id)!;
			result.push(lsp.Location.create(this.fromDatabase((document as Document).uri), this.asRange(value)));
			dedup.add(value.id);
		}
	}

	private findRangeFromPosition(file: string, position: lsp.Position): Range | undefined {
		const value = this.indices.documents.get(file);
		if (value === undefined) {
			return undefined;
		}
		const id = value.documents[0].id;
		let contains = this.out.contains.get(id);
		if (contains === undefined || contains.length === 0) {
			return undefined;
		}

		let candidate: Range | undefined;
		for (let item of contains) {
			if (item.label !== VertexLabels.range) {
				continue;
			}
			if (JsonStore.containsPosition(item, position)) {
				if (!candidate) {
					candidate = item;
				} else {
					if (JsonStore.containsRange(candidate, item)) {
						candidate = item;
					}
				}
			}
		}
		return candidate;
	}

	private asLocation(value: Range | lsp.Location): lsp.Location {
		if (lsp.Location.is(value)) {
			return value;
		} else {
			let document = this.in.contains.get(value.id)!;
			return lsp.Location.create(this.fromDatabase((document as Document).uri), this.asRange(value));
		}
	}

	private static containsPosition(range: lsp.Range, position: lsp.Position): boolean {
		if (position.line < range.start.line || position.line > range.end.line) {
			return false;
		}
		if (position.line === range.start.line && position.character < range.start.character) {
			return false;
		}
		if (position.line === range.end.line && position.character > range.end.character) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `otherRange` is in `range`. If the ranges are equal, will return true.
	 */
	public static containsRange(range: lsp.Range, otherRange: lsp.Range): boolean {
		if (otherRange.start.line < range.start.line || otherRange.end.line < range.start.line) {
			return false;
		}
		if (otherRange.start.line > range.end.line || otherRange.end.line > range.end.line) {
			return false;
		}
		if (otherRange.start.line === range.start.line && otherRange.start.character < range.start.character) {
			return false;
		}
		if (otherRange.end.line === range.end.line && otherRange.end.character > range.end.character) {
			return false;
		}
		return true;
	}
}