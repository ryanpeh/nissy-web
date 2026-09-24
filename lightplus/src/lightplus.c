/*
 * lightplus — experimental optimal step: `light` plus a cheap admissible
 * corner-permutation-separation bound.
 *
 * Nissy's `light` step bounds the HTM distance with:
 *   - pd_corners_HTM      (coud + full cp, HTM)
 *   - pd_drud_sym16_HTM   (coud + eofbepos_sym16, HTM, on 3 axes + inverse)
 *
 * The full optimal table `pd_nxopt31_HTM` is
 *   coud x cpud_separate x eofbepos_sym16   (~2.3 GB).
 * `light` has coud+cp and coud+eofbepos, but never couples the corner
 * permutation with eofbepos. This module adds the cheapest admissible piece
 * that does:
 *   pd_cpsep_eofbepos_HTM = cpud_separate x eofbepos_sym16
 *   = 70 x 64430 = 4,510,100 entries  (~2.25 MB at 4 bits)
 * and takes it as an extra lower bound. It sits between `light` and the
 * 2.3 GB table.
 *
 * All tables here use moveset_HTM, so the values are admissible lower bounds
 * for the HTM distance. (DR/HTR-moveset tables such as pd_cp_drud are NOT
 * admissible for HTM and are deliberately not used.)
 *
 * This is a research prototype in a fork; upstream nissy-2.0.8 is untouched.
 */

#include "steps.h"
#include "alg.h"
#include "coord.h"
#include "moves.h"
#include "trans.h"
#include "cube.h"
#include "utils.h"

#define UPDATECHECKSTOP(a, b, c)     if ((a=(MAX((a),(b))))>(c)) return (a);

#define LP_CLASSES_EOFBEPOS 64430

/* Exposed from symcoord.c (static removed in this fork). */
extern uint64_t move_eofbepos_16[NMOVES][LP_CLASSES_EOFBEPOS];
extern Trans    ttrep_move_eofbepos_16[NMOVES][LP_CLASSES_EOFBEPOS];
extern SymData  sd_eofbepos_16;

/* cpud_separate moved by a move / transformed by a symmetry. */
static int  cpsep_mtable[NMOVES][BINOM8ON4];
static int  trans_cpsep[NTRANS][BINOM8ON4];
static bool lp_initialized = false;

static void
lp_init(void)
{
	Move m;
	Trans t;
	int i;

	if (lp_initialized)
		return;

	for (i = 0; i < (int)BINOM8ON4; i++) {
		for (m = 0; m < NMOVES; m++)
			cpsep_mtable[m][i] = cpud_separate_ind[
			    cp_mtable[m][cpud_separate_ant[i]]];
		for (t = 0; t < NTRANS; t++)
			trans_cpsep[t][i] = cpud_separate_ind[
			    cp_ttable[t][cpud_separate_ant[i]]];
	}

	lp_initialized = true;
}

uint64_t
index_cpsep_eofbepos(Cube cube)
{
	uint64_t eofbepos;
	Trans t;

	lp_init();

	/* Mirror index_drud_sym16: store the coupled coordinate in the canonical
	 * (representative) frame, using transtorep, not the raw cube frame. */
	eofbepos = coord_eofbepos.index(cube);
	t = sd_eofbepos_16.transtorep[eofbepos];

	return (uint64_t)sd_eofbepos_16.class[eofbepos] * BINOM8ON4
	    + trans_cpsep[t][cpud_separate_ind[cube.cp]];
}

uint64_t
move_cpsep_eofbepos(Move m, uint64_t ind)
{
	uint64_t eofbepos, cpsep;
	Trans ttr;

	eofbepos = ind / BINOM8ON4;
	cpsep    = ind % BINOM8ON4;

	ttr      = ttrep_move_eofbepos_16[m][eofbepos];
	eofbepos = move_eofbepos_16[m][eofbepos];
	cpsep    = trans_cpsep[ttr][cpsep_mtable[m][cpsep]];

	return eofbepos * BINOM8ON4 + cpsep;
}

static Coordinate
coord_cpsep_eofbepos = {
	.index = index_cpsep_eofbepos,
	.move  = move_cpsep_eofbepos,
	.max   = LP_CLASSES_EOFBEPOS * BINOM8ON4,
};

static PruneData
pd_cpsep_eofbepos_HTM = {
	.filename = "pt_cpsep_eofbepos_HTM",
	.coord    = &coord_cpsep_eofbepos,
	.moveset  = &moveset_HTM,
};

static bool
lp_check_centers(Cube cube)
{
	return cube.cpos == 0;
}

static bool
lp_always_valid(Alg *alg)
{
	(void)alg;
	return true;
}

static char lp_ready_msg[100] = "cube must be oriented (centers solved)";

static int
estimate_lightplus_HTM(DfsArg *arg)
{
	int target, ret, cpsep;
	Cube aux;

	static const uint64_t udmask = (1<<U) | (1<<U2) | (1<<U3) |
				       (1<<D) | (1<<D2) | (1<<D3);
	static const uint64_t rlmask = (1<<R) | (1<<R2) | (1<<R3) |
				       (1<<L) | (1<<L2) | (1<<L3);
	static const uint64_t fbmask = (1<<F) | (1<<F2) | (1<<F3) |
				       (1<<B) | (1<<B2) | (1<<B3);
	static const uint64_t htmask = (1<<U2) | (1<<D2) |
				       (1<<R2) | (1<<L2) |
				       (1<<F2) | (1<<B2);

	ret              = -1;
	target           = arg->d - arg->current_alg->len;
	arg->inverse     = (Cube){0};
	arg->badmovesinv = 0;
	arg->badmoves    = 0;

	/* Corners */
	arg->ed->corners = ptableval(&pd_corners_HTM, arg->cube);
	UPDATECHECKSTOP(ret, arg->ed->corners, target);

	/* NEW: corner-permutation separation coupled with eofbepos. */
	cpsep = ptableval(&pd_cpsep_eofbepos_HTM, arg->cube);
	UPDATECHECKSTOP(ret, cpsep, target);

	/* Normal probing */
	arg->ed->normal_ud = ptableval(&pd_drud_sym16_HTM, arg->cube);
	UPDATECHECKSTOP(ret, arg->ed->normal_ud, target);
	aux = apply_trans(fd, arg->cube);
	arg->ed->normal_fb = ptableval(&pd_drud_sym16_HTM, aux);
	UPDATECHECKSTOP(ret, arg->ed->normal_fb, target);
	aux = apply_trans(rf, arg->cube);
	arg->ed->normal_rl = ptableval(&pd_drud_sym16_HTM, aux);
	UPDATECHECKSTOP(ret, arg->ed->normal_rl, target);

	/* If ret == 0, it's solved (corners + triple slice solved) */
	if (ret == 0)
		return is_solved(arg->cube) ? 0 : 1;

	/* Michel de Bondt's trick */
	if (arg->ed->normal_ud == arg->ed->normal_fb &&
	    arg->ed->normal_fb == arg->ed->normal_rl) {
		UPDATECHECKSTOP(ret, arg->ed->normal_ud + 1, target);
	}

	/* Inverse probing */
	if (!((1<<arg->last1) & htmask)) {
		aux = arg->inverse = inverse_cube(arg->cube);
		if (!((1<<arg->last1) & udmask) || (arg->ed->inverse_ud==-1)) {
			arg->ed->inverse_ud =
			    ptableval(&pd_drud_sym16_HTM, aux);
		}
		UPDATECHECKSTOP(ret, arg->ed->inverse_ud, target);
		if (!((1<<arg->last1) & fbmask) || (arg->ed->inverse_fb==-1)) {
			aux = apply_trans(fd, arg->inverse);
			arg->ed->inverse_fb =
			    ptableval(&pd_drud_sym16_HTM, aux);
		}
		UPDATECHECKSTOP(ret, arg->ed->inverse_fb, target);
		if (!((1<<arg->last1) & rlmask) || (arg->ed->inverse_rl==-1)) {
			aux = apply_trans(rf, arg->inverse);
			arg->ed->inverse_rl =
			    ptableval(&pd_drud_sym16_HTM, aux);
		}
		UPDATECHECKSTOP(ret, arg->ed->inverse_rl, target);
	} else {
		UPDATECHECKSTOP(ret, arg->ed->inverse_ud, target);
		UPDATECHECKSTOP(ret, arg->ed->inverse_fb, target);
		UPDATECHECKSTOP(ret, arg->ed->inverse_rl, target);
	}

	/* Michel de Bondt's trick */
	if (arg->ed->inverse_ud == arg->ed->inverse_fb &&
	    arg->ed->inverse_fb == arg->ed->inverse_rl) {
		UPDATECHECKSTOP(ret, arg->ed->inverse_ud + 1, target);
	}

	/* nxopt trick + half turn trick */
	if (arg->ed->normal_ud == target)
		arg->badmovesinv |= udmask | htmask;
	if (arg->ed->normal_fb == target)
		arg->badmovesinv |= fbmask | htmask;
	if (arg->ed->normal_rl == target)
		arg->badmovesinv |= rlmask | htmask;

	if (arg->ed->inverse_ud == target)
		arg->badmoves |= udmask | htmask;
	if (arg->ed->inverse_fb == target)
		arg->badmoves |= fbmask | htmask;
	if (arg->ed->inverse_rl == target)
		arg->badmoves |= rlmask | htmask;

	return arg->ed->oldret = ret;
}

Step
lightplus_HTM = {
	.shortname = "lightplus",
	.name      = "Optimal solve (HTM), light + corner-separation bound",

	.final     = true,
	.is_done   = is_solved,
	.estimate  = estimate_lightplus_HTM,
	.ready     = lp_check_centers,
	.ready_msg = lp_ready_msg,
	.is_valid  = lp_always_valid,
	.moveset   = &moveset_HTM,

	.pre_trans = uf,

	.tables    = {&pd_drud_sym16_HTM, &pd_corners_HTM, &pd_cpsep_eofbepos_HTM},
	.ntables   = 3,
};
