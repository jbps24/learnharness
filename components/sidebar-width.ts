/*
 * The sidebar's width model (plan 016): the learner's drag is stored as a
 * share of the window width, so the sidebar follows the window. The width is
 * clamped to [MIN, MAX], and never so wide that the lesson area drops below
 * LESSON_MIN_WIDTH (the 640px window floor). MIN + LESSON_MIN_WIDTH is the
 * auto-close threshold; electron/main.cjs mirrors SIDEBAR_AUTOCLOSE.
 */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const LESSON_MIN_WIDTH = 640;
export const SIDEBAR_AUTOCLOSE = SIDEBAR_MIN_WIDTH + LESSON_MIN_WIDTH;
/** 288px at the 1440px reference window — the old fixed width. */
export const DEFAULT_SIDEBAR_SHARE = 0.2;

export function sidebarWidth(share: number, windowWidth: number): number {
	const wanted = Math.min(Math.max(Math.round(share * windowWidth), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
	return Math.min(wanted, Math.max(windowWidth - LESSON_MIN_WIDTH, 0));
}

export function shareFor(widthPx: number, windowWidth: number): number {
	return windowWidth > 0 ? widthPx / windowWidth : DEFAULT_SIDEBAR_SHARE;
}
