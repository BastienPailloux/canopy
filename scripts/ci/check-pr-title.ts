import { checkPrTitle } from './prTitle.ts'

// The title comes through the environment, never interpolated in the workflow script (injection).
// The error quotes parts of the title: plain stderr, no `::error` workflow command it could extend.
const error = checkPrTitle(process.env.PR_TITLE ?? '')
if (error) {
  console.error(`Titre de PR invalide : ${error}`)
  process.exit(1)
}
console.log('Titre de PR valide.')
