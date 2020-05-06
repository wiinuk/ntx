import "mocha"
import { assert } from "chai"
import { promisify } from "util"
import { _makeOnChange } from "../src/index"

const sleep = promisify(setTimeout)

describe("tests", () => {
    it("makeOnChange", async function () {
        this.timeout(10000)

        let log = ""
        async function f(i: ReadonlyArray<number>) {
            log += `begin: ${i}\n`
            await sleep(500);
            log += `end: ${i}\n`
        }

        const onchange = _makeOnChange(f)

        for (let i = 10; i--;) {
            log += `${i}\n`
            onchange(i, e => { throw e })
            await sleep(100)
        }

        assert.deepEqual(log, "9\nbegin: 9\n8\n7\n6\n5\nend: 9\nbegin: 8,7,6,5\n4\n3\n2\n1\n0\nend: 8,7,6,5\nbegin: 4,3,2,1,0\n")
    })
})
