import { checkPrTitle } from './prTitle.ts'

// The title comes through the environment, never interpolated in the workflow script (injection).
const error = checkPrTitle(process.env.PR_TITLE ?? '')
if (error) {
  console.error(`::error title=Titre de PR invalide::${error}`)
  process.exit(1)
}
console.log('Titre de PR valide.')
