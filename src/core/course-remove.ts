import type { CourseMaterial } from "./contracts/course.ts";

/** Plan 014: drop a course file and every stored entry that names it. Changes nothing else. */
export function removeCourseFile(material: CourseMaterial, path: string): CourseMaterial {
	const { examPatterns, referenceIndex, referencePointers, propositionMethods, propositionExamPatterns, bookRoutes, ...others } = material;
	return {
		...others,
		files: material.files.filter((file) => file.path !== path),
		methods: material.methods.filter((method) => method.path !== path),
		conflicts: material.conflicts
			.map(({ chosen, ...conflict }) => ({
				...conflict,
				paths: conflict.paths.filter((p) => p !== path),
				...(chosen !== undefined && chosen !== path ? { chosen } : {}),
			}))
			.filter((conflict) => conflict.paths.length >= 2),
		...(examPatterns ? { examPatterns: examPatterns.filter((entry) => entry.path !== path) } : {}),
		...(referenceIndex ? { referenceIndex: referenceIndex.filter((entry) => entry.path !== path) } : {}),
		...(referencePointers ? { referencePointers: referencePointers.filter((entry) => entry.path !== path) } : {}),
		...(propositionMethods ? { propositionMethods: propositionMethods.filter((entry) => entry.path !== path) } : {}),
		...(bookRoutes ? { bookRoutes: bookRoutes.filter((entry) => entry.path !== path) } : {}),
		...(propositionExamPatterns ? { propositionExamPatterns: propositionExamPatterns.filter((entry) => entry.path !== path) } : {}),
	};
}
