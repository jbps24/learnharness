export type CourseFileStatus = "pending" | "assigning" | "assigned" | "failed" | "not-assignable";

export interface CourseFile {
	path: string;            // absolute, home-resolved; the identity
	addedAt: string;         // ISO
	via: "learner" | "tutor" | "inherited";
	binding: boolean;        // the learner's tick; true when added
	status: CourseFileStatus;
	error?: string;          // only when status is "failed"
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
	path: string;
	pages?: string;
	method: string;
}

export interface CourseMaterial {
	files: CourseFile[];
	methods: NodeMethod[];
	conflicts: NodeConflict[];
	/** Practice sessions only: the snapshot taken at creation (Part 6). */
	propositionMethods?: PropositionMethod[];
}

export const COURSE_METHOD_CAP = 1_500;
export const ASSIGNABLE_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt", ".tex"] as const;
