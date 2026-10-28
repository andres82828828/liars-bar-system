// =====================================================================
//  SORTING ALGORITHMS (hand-written, without Array.sort)
//  Used to organize products, e.g. from HIGHEST to LOWEST price.
//
//  All of them receive:
//    list → array of products (not modified; they work on a copy)
//    cmp  → comparator: cmp(a, b) < 0 when "a" must go BEFORE "b"
//  and return: { list: <sorted array>, comparisons: <number> }
//
//  Complexity:  Bubble, Insertion, Selection → O(n²)
//               Merge Sort, Quick Sort       → O(n log n)
// =====================================================================
const Sorting = (() => {

    // ---------- 1) BUBBLE: compares neighbours and swaps them when they are in the wrong order ----------
    function bubbleSort(list, cmp) {
        const a = list.slice();
        let comparisons = 0;
        for (let i = 0; i < a.length - 1; i++) {
            let swapped = false;
            for (let j = 0; j < a.length - 1 - i; j++) {
                comparisons++;
                if (cmp(a[j], a[j + 1]) > 0) {
                    [a[j], a[j + 1]] = [a[j + 1], a[j]];
                    swapped = true;
                }
            }
            if (!swapped) break;                    // already sorted: stops early
        }
        return { list: a, comparisons };
    }

    // ---------- 2) INSERTION: takes each element and "inserts" it in its place among the sorted ones ----------
    function insertionSort(list, cmp) {
        const a = list.slice();
        let comparisons = 0;
        for (let i = 1; i < a.length; i++) {
            const current = a[i];
            let j = i - 1;
            while (j >= 0) {
                comparisons++;
                if (cmp(a[j], current) > 0) { a[j + 1] = a[j]; j--; }
                else break;
            }
            a[j + 1] = current;
        }
        return { list: a, comparisons };
    }

    // ---------- 3) SELECTION: finds the best element of the rest and puts it in position i ----------
    function selectionSort(list, cmp) {
        const a = list.slice();
        let comparisons = 0;
        for (let i = 0; i < a.length - 1; i++) {
            let best = i;
            for (let j = i + 1; j < a.length; j++) {
                comparisons++;
                if (cmp(a[j], a[best]) < 0) best = j;
            }
            if (best !== i) [a[i], a[best]] = [a[best], a[i]];
        }
        return { list: a, comparisons };
    }

    // ---------- 4) MERGE SORT: splits in half, sorts each half and merges them ----------
    function mergeSort(list, cmp) {
        let comparisons = 0;

        function sort(a) {
            if (a.length <= 1) return a;
            const middle = Math.floor(a.length / 2);
            const left = sort(a.slice(0, middle));
            const right = sort(a.slice(middle));
            return merge(left, right);
        }

        function merge(left, right) {
            const res = [];
            let i = 0, j = 0;
            while (i < left.length && j < right.length) {
                comparisons++;
                if (cmp(left[i], right[j]) <= 0) res.push(left[i++]);
                else res.push(right[j++]);
            }
            while (i < left.length) res.push(left[i++]);
            while (j < right.length) res.push(right[j++]);
            return res;
        }

        return { list: sort(list.slice()), comparisons };
    }

    // ---------- 5) QUICK SORT: picks a pivot and separates smaller and larger elements ----------
    function quickSort(list, cmp) {
        const a = list.slice();
        let comparisons = 0;

        function sort(start, end) {
            if (start >= end) return;
            const middle = Math.floor((start + end) / 2);          // middle pivot (avoids the worst case on sorted lists)
            [a[middle], a[end]] = [a[end], a[middle]];
            const pivot = a[end];
            let pos = start;
            for (let j = start; j < end; j++) {
                comparisons++;
                if (cmp(a[j], pivot) < 0) { [a[pos], a[j]] = [a[j], a[pos]]; pos++; }
            }
            [a[pos], a[end]] = [a[end], a[pos]];                    // the pivot ends up in its final position
            sort(start, pos - 1);
            sort(pos + 1, end);
        }

        sort(0, a.length - 1);
        return { list: a, comparisons };
    }

    // ---------- Available methods ----------
    const methods = {
        merge:     { name: 'Merge Sort',     complexity: 'O(n log n)', fn: mergeSort },
        quick:     { name: 'Quick Sort',     complexity: 'O(n log n)', fn: quickSort },
        insertion: { name: 'Insertion Sort', complexity: 'O(n²)',      fn: insertionSort },
        selection: { name: 'Selection Sort', complexity: 'O(n²)',      fn: selectionSort },
        bubble:    { name: 'Bubble Sort',    complexity: 'O(n²)',      fn: bubbleSort }
    };

    // ---------- Sort criteria (ties broken by code so the result is always the same) ----------
    const price = (x) => Number(x.price !== undefined ? x.price : x.salePrice);   // catalog uses "price", products "salePrice"
    const byCode = (a, b) => String(a.code).localeCompare(String(b.code));

    const criteria = {
        'price-desc': { name: 'Price: high to low', cmp: (a, b) => (price(b) - price(a)) || byCode(a, b) },
        'price-asc':  { name: 'Price: low to high', cmp: (a, b) => (price(a) - price(b)) || byCode(a, b) },
        'name-asc':   { name: 'Name: A → Z',        cmp: (a, b) => String(a.name).localeCompare(String(b.name), 'en') || byCode(a, b) }
    };

    // Entry point: sorts "list" with the chosen method and criterion
    function sort(list, method = 'merge', criterion = 'price-desc') {
        const m = methods[method] || methods.merge;
        const c = criteria[criterion] || criteria['price-desc'];
        const r = m.fn(list, c.cmp);
        return { ...r, method: m.name, complexity: m.complexity, criterion: c.name };
    }

    return { methods, criteria, sort };
})();

if (typeof module !== 'undefined') module.exports = Sorting;   // allows testing it with Node
