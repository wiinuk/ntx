//@ts-check
const { start, r } = require("./out/src/index")
const osLocale = require("os-locale")

process.env.LANG = ""
const locale = osLocale()

const clean = r`rimraf ./out`
const watch = r`tsc --watch --project . --locale ${locale}`
const compile = r`tsc --project . --locale ${locale}`
const test = compile.then(r`mocha out/**/*.js -u tdd --no-timeouts --colors`)
const prepublishOnly = clean.then(test)

start({
    prepublishOnly,
    test,
    watch,
})
