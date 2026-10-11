Quiz attempt records, one JSON file per week, written by /api/attempts.

This branch is not deployed: the vercel.json beside this file disables
deployments for it, so recording a score does not rebuild the site.
Vercel reads that setting from the branch being pushed, which is why the
copy on main is not enough on its own.
