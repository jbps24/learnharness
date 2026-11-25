export type CourseFileStatus = "pending" | "assigning" | "assigned" | "failed" | "not-assignable";

export interface CourseFile {
	path: string;            // absolute, home-resolved; the identity
	addedAt: string;         // ISO
	via: "learner" | "tutor" | "inherited";
	binding: boolean;        // the learner's tick; true when added
	status: CourseFileStatus;
	error?: string;          // only when status is "failed"
	category?: "material" | "exam" | "reference";
	categoryBy?: "reader" | "learner";
	materialKind?: "complete" | "overview";
	materialKindBy?: "reader" | "learner";
	fingerprint?: { size: number; mtimeMs: number; sha256: string };
	changedOnDisk?: boolean;
	update?: CourseUpdate;
}

export interface CourseUpdate {
	at: string;
	fromPath: string;
	previous: Array<{ nodeId: string; pages?: string; method: string }>;
	nodes?: Array<{ nodeId: string; kind: "same" | "changed" | "new" | "dropped" }>;
	newSections?: Array<{ title: string; pages: string }>;
	revisited: string[];
	planAsked: boolean;
}

export interface ReferenceSection {
	id: string;
	title: string;
	level: number;
	startPage: number;
	endPage: number;
	label?: string;
}

export interface NodeMethod {
	nodeId: string;
	path: string;            // the course file it came from
	pages?: string;          // e.g. "S. 20–27"
	method: string;          // ≤ COURSE_METHOD_CAP chars
}

export interface NodeConflict {
	nodeId: string;
	paths: string[];         // ≥ 2 course files with different routes, in the order found
	chosen?: string;         // set by course_route; one of paths
}

export interface PropositionMethod {
	propositionId: string;
	lessonId: string;
	nodeId: string;
	role?: "book";
	path: string;
	pages?: string;
	method: string;
}

export interface ExamPattern {
	nodeId: string;
	path: string;
	source: string;
	pages?: string;
	pattern: string;
	grading?: string;
}

export interface CourseMaterial {
	files: CourseFile[];
	methods: NodeMethod[];
	conflicts: NodeConflict[];
	/** Practice sessions only: the snapshot taken at creation (Part 6). */
	propositionMethods?: PropositionMethod[];
	examPatterns?: ExamPattern[];
	propositionExamPatterns?: Array<ExamPattern & { propositionId: string; lessonId: string }>;
	referenceIndex?: Array<{ path: string; from: "outline" | "contents" | "headings"; sections: ReferenceSection[] }>;
	referencePointers?: Array<{ nodeId: string; path: string; sectionIds: string[] }>;
	bookRoutes?: BookRoute[];
}

export interface BookRoute {
	nodeId: string;
	path: string;
	sectionIds: string[];
	pages: string;
	method: string;
	error?: string;
}

export const COURSE_METHOD_CAP = 1_500;
export const EXAM_PATTERN_CAP = 1_200;
export const REFERENCE_SECTIONS_CAP = 800;
export const NEW_SECTIONS_CAP = 15;
export const BOOK_ROUTE_CAP = 2_500;
export const ASSIGNABLE_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt", ".tex"] as const;

export function fileCategory(file: CourseFile): "material" | "exam" | "reference" {
	return file.category ?? "material";
}

export function fileMaterialKind(file: CourseFile): "complete" | "overview" {
	return file.materialKind ?? "complete";
}
