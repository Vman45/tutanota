//@flow
import {MailTypeRef} from "../../entities/tutanota/Mail"
import {DbTransaction, ElementDataOS, SearchIndexMetaDataOS, SearchIndexOS, SearchIndexWordsIndex} from "./DbFacade"
import {compareNewestFirst, firstBiggerThanSecond, isSameTypeRef, resolveTypeReference, TypeRef} from "../../common/EntityFunctions"
import {tokenize} from "./Tokenizer"
import {arrayHash, contains, flat} from "../../common/utils/ArrayUtils"
import {asyncFind, defer, downcast, neverNull} from "../../common/utils/Utils"
import type {
	Db,
	ElementDataDbRow,
	EncryptedSearchIndexEntry,
	EncryptedSearchIndexEntryWithHash,
	KeyToEncryptedIndexEntries,
	KeyToIndexEntries,
	MoreResultsIndexEntry,
	SearchIndexEntry,
	SearchIndexMetaDataDbRow,
	SearchIndexMetadataEntry
} from "./SearchTypes"
import {
	decryptMetaData,
	decryptSearchIndexEntry,
	encryptIndexKeyBase64,
	getIdFromEncSearchIndexEntry,
	getPerformanceTimestamp,
	timeEnd,
	timeStart,
	typeRefToTypeInfo
} from "./IndexUtils"
import {FULL_INDEXED_TIMESTAMP, NOTHING_INDEXED_TIMESTAMP} from "../../common/TutanotaConstants"
import {timestampToGeneratedId, uint8ArrayToBase64} from "../../common/utils/Encoding"
import {MailIndexer} from "./MailIndexer"
import {LoginFacade} from "../facades/LoginFacade"
import {getStartOfDay} from "../../common/utils/DateUtils"
import {SuggestionFacade} from "./SuggestionFacade"
import {load} from "../EntityWorker"
import EC from "../../common/EntityConstants"
import {NotAuthorizedError, NotFoundError} from "../../common/error/RestError"
import {CancelledError} from "../../common/error/CancelledError"
import {mapInCallContext} from "../../common/utils/PromiseUtils"
import {iterateBinaryBlocks} from "./SearchIndexEncoding"

const ValueType = EC.ValueType
const Cardinality = EC.Cardinality
const AssociationType = EC.AssociationType

export class SearchFacade {
	_loginFacade: LoginFacade;
	_db: Db;
	_mailIndexer: MailIndexer;
	_suggestionFacades: SuggestionFacade<any>[];

	constructor(loginFacade: LoginFacade, db: Db, mailIndexer: MailIndexer, suggestionFacades: SuggestionFacade<any>[]) {
		this._loginFacade = loginFacade
		this._db = db
		this._mailIndexer = mailIndexer
		this._suggestionFacades = suggestionFacades
	}

	/****************************** SEARCH ******************************/

	/**
	 * Invoke an AND-query.
	 * @param query is tokenized. All tokens must be matched by the result (AND-query)
	 * @param minSuggestionCount If minSuggestionCount > 0 regards the last query token as suggestion token and includes suggestion results for that token, but not less than minSuggestionCount
	 * @returns The result ids are sorted by id from newest to oldest
	 */
	search(query: string, restriction: SearchRestriction, minSuggestionCount: number,
	       maxResults: ?number): Promise<SearchResult> {
		console.timeStamp && console.timeStamp("search start")
		return this._db.initialized.then(() => {
			let searchTokens = tokenize(query)

			let totalSearchTimeStart = getPerformanceTimestamp()
			let timing = {}

			let result: SearchResult = {
				query,
				restriction,
				results: [],
				currentIndexTimestamp: this._getSearchEndTimestamp(restriction),
				moreResultsEntries: [],
				lastReadSearchIndexRow: searchTokens.map((token) => [token, null]),
				matchWordOrder: searchTokens.length > 1 && query.startsWith("\"") && query.endsWith("\"")
			}
			if (searchTokens.length > 0) {
				let isFirstWordSearch = searchTokens.length === 1
				let before = getPerformanceTimestamp()
				console.timeStamp && console.timeStamp("find suggestions")
				let suggestionFacade = this._suggestionFacades.find(f => isSameTypeRef(f.type, restriction.type))
				timing.suggestionSearchTime = getPerformanceTimestamp() - before
				let searchPromise
				if (minSuggestionCount > 0 && isFirstWordSearch && suggestionFacade) {
					let addSuggestionBefore = getPerformanceTimestamp()
					timing.addSuggestionsTime = getPerformanceTimestamp() - addSuggestionBefore
					// there may be fields that are not indexed with suggestions but which we can find with the normal search
					// TODO: let suggestion facade and search facade know which fields are
					// indexed with suggestions, so that we
					// 1) know if we also have to search normally and
					// 2) in which fields we have to search for second word suggestions because now we would also find words of non-suggestion fields as second words
					let searchForTokensAfterSuggestionsBefore = getPerformanceTimestamp()
					return this._searchForTokens(result, suggestionFacade.getSuggestions(searchTokens[0]), maxResults)
					           .then(() => {
						           timing.searchForTokensAfterSuggestions = getPerformanceTimestamp()
							           - searchForTokensAfterSuggestionsBefore
						           return result
					           })
				} else if (minSuggestionCount > 0 && !isFirstWordSearch && suggestionFacade) {
					let beforeSearchTokens = getPerformanceTimestamp()
					let suggestionToken = neverNull(result.lastReadSearchIndexRow.pop())[0]
					searchPromise = this._searchForTokens(result, [suggestionToken]).then(() => {
						timing.searchForTokensTotal = getPerformanceTimestamp() - beforeSearchTokens
						// we now filter for the suggestion token manually because searching for suggestions for the last word and reducing the initial search result with them can lead to
						// dozens of searches without any effect when the seach token is found in too many contacts, e.g. in the email address with the ending "de"
						result.results.sort(compareNewestFirst)
						let beforeLoadAndReduce = getPerformanceTimestamp()
						return this._loadAndReduce(restriction, result.results, suggestionToken, minSuggestionCount)
						           .then(filteredResults => {
							           timing._loadAndReduceTime = getPerformanceTimestamp() - beforeLoadAndReduce
							           result.results = filteredResults
						           })
					})
				} else {
					let beforeSearchTokens = getPerformanceTimestamp()
					console.timeStamp && console.timeStamp("search for tokens")
					searchPromise = this._searchForTokens(result, [], maxResults)
					                    .then((result) => {
						                    timing.searchForTokensTotal = getPerformanceTimestamp() - beforeSearchTokens
						                    return result
					                    })
				}

				return searchPromise.then(() => {
					result.results.sort(compareNewestFirst)
					timing.total = getPerformanceTimestamp() - totalSearchTimeStart
					typeof self !== "undefined" && console.log(JSON.stringify(timing))
					return result
				})
			} else {
				return Promise.resolve(result)
			}
		})
	}

	_loadAndReduce(restriction: SearchRestriction, results: IdTuple[], suggestionToken: string, minSuggestionCount: number): Promise<IdTuple[]> {
		if (results.length > 0) {
			return resolveTypeReference(restriction.type).then(model => {
				// TODO enable when loadMultiple is supported by cache
				// if (restriction.listId) {
				// 	let result: IdTuple[] = []
				// 	// we can load multiple at once because they have the same list id
				// 	return executeInGroups(results, minSuggestionCount, idTuples => {
				// 		return loadMultiple(restriction.type, idTuples[0][0], idTuples.map(t => t[1])).filter(entity => {
				// 			return this._containsSuggestionToken(entity, model, restriction.attributeIds, suggestionToken)
				// 		}).then(filteredEntityGroup => {
				// 			addAll(result, filteredEntityGroup.map(entity => entity._id))
				// 			return result.length < minSuggestionCount
				// 		})
				// 	}).then(() => {
				// 		return result
				// 	})
				// } else {
				// load one by one
				return Promise.reduce(results, (finalResults, result) => {
					if (finalResults.length >= minSuggestionCount) {
						return finalResults
					} else {
						return load(restriction.type, result).then(entity => {
							return this._containsSuggestionToken(entity, model, restriction.attributeIds, suggestionToken)
							           .then(found => {
								           if (found) {
									           finalResults.push(result)
								           }
								           return finalResults
							           })
						}).catch(NotFoundError, e => {
							return finalResults
						}).catch(NotAuthorizedError, e => {
							return finalResults
						})
					}
				}, [])
				// }
			})
		} else {
			return Promise.resolve([])
		}
	}

	/**
	 * Looks for a word in any of the entities string values or aggregations string values that starts with suggestionToken.
	 * @param attributeIds Only looks in these attribute ids (or all its string values if it is an aggregation attribute id. If null, looks in all string values and aggregations.
	 */
	_containsSuggestionToken(entity: Object, model: TypeModel, attributeIds: ?number[], suggestionToken: string): Promise<boolean> {
		let attributeNames: string[]
		if (!attributeIds) {
			attributeNames = Object.keys(model.values).concat(Object.keys(model.associations))
		} else {
			attributeNames = attributeIds.map(id => neverNull(
				Object.keys(model.values).find(valueName => model.values[valueName].id === id) ||
				Object.keys(model.associations).find(associationName => model.associations[associationName].id === id)
			))
		}
		return asyncFind(attributeNames, attributeName => {
			if (model.values[attributeName] && model.values[attributeName].type === ValueType.String
				&& entity[attributeName]) {
				let words = tokenize(entity[attributeName])
				return Promise.resolve((words.find(w => w.startsWith(suggestionToken))) != null)
			} else if (model.associations[attributeName]
				&& model.associations[attributeName].type === AssociationType.Aggregation && entity[attributeName]) {
				let aggregates = (model.associations[attributeName].cardinality === Cardinality.Any) ?
					entity[attributeName] : [entity[attributeName]]
				return resolveTypeReference(new TypeRef(model.app, model.associations[attributeName].refType))
					.then(refModel => {
						return asyncFind(aggregates, aggregate => {
							return this._containsSuggestionToken(aggregate, refModel, null, suggestionToken)
						}).then(found => found != null)
					})
			} else {
				return Promise.resolve(false)
			}
		}).then(found => found != null)
	}


	/**
	 * Adds the found ids to the given search result
	 */
	_searchForTokens(searchResult: SearchResult, suggestions: Array<string>, maxResults: ?number): Promise<void> {
		timeStart("_tryExtendIndex")
		// TODO take care of suggestions
		return this._tryExtendIndex(searchResult.restriction).then(() => {
				makeStamp("_tryExtendIndex")
				return this._startOrContinueSearch(searchResult, maxResults)
			}
		)
	}

	_startOrContinueSearch(searchResult: SearchResult, maxResults: ?number): Promise<void> {
		timeStart("findIndexEntries")
		return this._findIndexEntries(searchResult, maxResults)
		           .then(keyToEncryptedIndexEntries => {
			           makeStamp("findIndexEntries")
			           timeStart("_filterByEncryptedId")
			           return this._filterByEncryptedId(keyToEncryptedIndexEntries)
		           })
		           .then(keyToEncryptedIndexEntries => {
			           makeStamp("_filterByEncryptedId")
			           timeStart("_decryptSearchResult")
			           return this._decryptSearchResult(keyToEncryptedIndexEntries)
		           })
		           .then(keyToIndexEntries => {
			           makeStamp("_decryptSearchResult")
			           timeStart("_filterByTypeAndAttributeAndTime")
			           return this._filterByTypeAndAttributeAndTime(keyToIndexEntries, searchResult.restriction)
		           })
		           .then(keyToIndexEntries => {
			           makeStamp("_filterByTypeAndAttributeAndTime")
			           timeStart("_reduceWords")
			           return this._reduceWords(keyToIndexEntries, searchResult.matchWordOrder)
		           })
		           .then(searchIndexEntries => {
			           makeStamp("_reduceWords")
			           timeStart("_reduceToUniqueElementIds")
			           return this._reduceToUniqueElementIds(searchIndexEntries, searchResult)
		           })
		           .then((searchIndexEntries: SearchIndexEntry[]) => {
			           makeStamp("_reduceToUniqueElementIds")
			           timeStart("_filterByListIdAndGroupSearchResults")
			           return this._filterByListIdAndGroupSearchResults(downcast(searchIndexEntries), searchResult,
				           maxResults)
		           })
		           .then((result) => {
			           makeStamp("_filterByListIdAndGroupSearchResults")
			           typeof self !== "undefined" && console.log(JSON.stringify(timings))
			           return result
		           })

	}

	/**
	 * Adds suggestions for the given searchToken to the searchResult until at least minSuggestionCount results are existing
	 */
	// _addSuggestions(searchToken: string, suggestionFacade: SuggestionFacade<any>, minSuggestionCount: number,
	//                 searchResult: SearchResult, maxResults: ?number): Promise<void> {
	// 	let suggestions = suggestionFacade.getSuggestions(searchToken)
	// 	return Promise.each(suggestions, suggestion => {
	// 		if (searchResult.results.length < minSuggestionCount) {
	//
	// 			return this._searchForTokens([suggestion], false, searchResult)
	// 		}
	// 	}).then(() => maxResults && searchResult.results.splice(maxResults)).return()
	// }


	_tryExtendIndex(restriction: SearchRestriction): Promise<void> {
		if (isSameTypeRef(MailTypeRef, restriction.type)) {
			return this._mailIndexer.mailboxIndexingPromise.then(() => {
				if (this._mailIndexer.currentIndexTimestamp > FULL_INDEXED_TIMESTAMP && restriction.end
					&& this._mailIndexer.currentIndexTimestamp > restriction.end) {
					this._mailIndexer.indexMailboxes(this._loginFacade.getLoggedInUser(), getStartOfDay(new Date(neverNull(restriction.end)))
						.getTime()).catch(CancelledError, (e) => {console.log("extend mail index has been cancelled", e)})
					return this._mailIndexer.mailboxIndexingPromise
				}
			}).catch(CancelledError, e => {console.log("extend mail index has been cancelled", e)})
		} else {
			return Promise.resolve()
		}
	}

	_findIndexEntries(searchResult: SearchResult, maxResults: ?number): Promise<KeyToEncryptedIndexEntries[]> {
		return this._db.dbFacade.createTransaction(true, [SearchIndexOS, SearchIndexMetaDataOS])
		           .then(transaction =>
			           mapInCallContext(
				           searchResult.lastReadSearchIndexRow,
				           (token) => this._findEntriesForSearchToken(transaction, token, searchResult, maxResults)))
	}

	_findEntriesForMetadata(transaction: DbTransaction, entry: SearchIndexMetadataEntry, fromRow: ?number, maxResults: ?number): Promise<EncryptedSearchIndexEntry[]> {
		return transaction.get(SearchIndexOS, entry.key).then((indexEntriesRow) => {
			if (!indexEntriesRow) return []
			const result = new Array(entry.size)
			iterateBinaryBlocks(indexEntriesRow, (block, s, e, iteration) => {
				result[iteration] = block
			})
			return result
		})
	}

	_findEntriesForSearchToken(transaction: DbTransaction, searchTokenInfo: [string, ?number], searchResult: SearchResult,
	                           maxResults: ?number): Promise<KeyToEncryptedIndexEntries> {
		const [searchToken, fromRow] = searchTokenInfo
		let indexKey = encryptIndexKeyBase64(this._db.key, searchToken, this._db.iv)
		return transaction
			.get(SearchIndexMetaDataOS, indexKey, SearchIndexWordsIndex)
			.then((metaData: ?SearchIndexMetaDataDbRow) => {
				const safeRows = metaData ? decryptMetaData(this._db.key, metaData).rows : []
				const typeInfo = typeRefToTypeInfo(searchResult.restriction.type)
				const filteredRows = safeRows.filter(r => r.app === typeInfo.appId && r.type === typeInfo.typeId)
				filteredRows.reverse()
				let entitiesToRead = 0
				let lastReadRowId = 0
				const rowsToRead = filteredRows.filter(r => {
					if (maxResults) {
						if ((!fromRow || r.key < fromRow) && entitiesToRead < 1000) {
							entitiesToRead += r.size
							lastReadRowId = r.key
							return true
						}
						return false
					} else {
						return true
					}
				})
				console.log("maxresults", maxResults, "rowsToRead", rowsToRead)

				searchTokenInfo[1] = lastReadRowId
				return mapInCallContext(rowsToRead, (entry) => this._findEntriesForMetadata(transaction, entry))
			})
			.then((results: EncryptedSearchIndexEntry[][]) => flat(results))
			.then((indexEntries: EncryptedSearchIndexEntry[]) => {
				return indexEntries.map(entry => ({
					encEntry: entry,
					idHash: arrayHash(getIdFromEncSearchIndexEntry(entry))
				}))
			})
			.then((indexEntries: EncryptedSearchIndexEntryWithHash[]) => {
				return {
					indexKey: indexKey,
					indexEntries: indexEntries
				}
			})
	}

	/**
	 * Reduces the search result by filtering out all mailIds that don't match all search tokens
	 */
	_filterByEncryptedId(results: KeyToEncryptedIndexEntries[]): KeyToEncryptedIndexEntries[] {
		// let matchingEncIds = null
		let matchingEncIds: Set<number>
		results.forEach(keyToEncryptedIndexEntry => {
			if (matchingEncIds == null) {
				matchingEncIds = new Set(keyToEncryptedIndexEntry.indexEntries.map(entry => entry.idHash))
			} else {
				let filtered = new Set()
				keyToEncryptedIndexEntry.indexEntries.forEach(indexEntry => {
					if (matchingEncIds.has(indexEntry.idHash)) {
						filtered.add(indexEntry.idHash)
					}
				})
				matchingEncIds = filtered
			}
		})
		return results.map(r => {
			return {
				indexKey: r.indexKey,
				indexEntries: r.indexEntries.filter(entry => matchingEncIds.has(entry.idHash))
			}
		})
	}


	_decryptSearchResult(results: KeyToEncryptedIndexEntries[]): KeyToIndexEntries[] {
		return results.map(searchResult => {
			return {
				indexKey: searchResult.indexKey,
				indexEntries: searchResult.indexEntries.map(entry => decryptSearchIndexEntry(this._db.key, entry.encEntry, this._db.iv))
			}
		})
	}


	_filterByTypeAndAttributeAndTime(results: KeyToIndexEntries[], restriction: SearchRestriction): KeyToIndexEntries[] {
		// first filter each index entry by itself
		let endTimestamp = this._getSearchEndTimestamp(restriction)
		const minIncludedId = timestampToGeneratedId(endTimestamp)
		const maxExcludedId = restriction.start ? timestampToGeneratedId(restriction.start + 1) : null
		results.forEach(result => {
			result.indexEntries = result.indexEntries.filter(entry => {
				return this._isValidAttributeAndTime(restriction, entry, minIncludedId, maxExcludedId)
			})
		})

		// now filter all ids that are in all of the search words
		let matchingIds: Set<Id>
		results.forEach(keyToIndexEntry => {
			if (!matchingIds) {
				matchingIds = new Set(keyToIndexEntry.indexEntries.map(entry => entry.id))
			} else {
				let filtered = new Set()
				keyToIndexEntry.indexEntries.forEach(entry => {
					if (matchingIds.has(entry.id)) {
						filtered.add(entry.id)
					}
				})
				matchingIds = filtered
			}
		})
		return results.map(r => {
			return {
				indexKey: r.indexKey,
				indexEntries: r.indexEntries.filter(entry => matchingIds.has(entry.id))
			}
		})
	}

	_isValidAttributeAndTime(restriction: SearchRestriction, entry: SearchIndexEntry, minIncludedId: Id,
	                         maxExcludedId: ?Id): boolean {
		if (restriction.attributeIds) {
			if (!contains(restriction.attributeIds, entry.attribute)) {
				return false
			}
		}
		if (maxExcludedId) {
			// timestampToGeneratedId provides the lowest id with the given timestamp (server id and counter set to 0),
			// so we add one millisecond to make sure all ids of the timestamp are covered
			if (!firstBiggerThanSecond(maxExcludedId, entry.id)) {
				return false
			}
		}
		return !firstBiggerThanSecond(minIncludedId, entry.id);

	}

	_reduceWords(results: KeyToIndexEntries[], matchWordOrder: boolean): SearchIndexEntry[] {
		if (matchWordOrder) {
			return results[0].indexEntries.filter(firstWordEntry => {
				// reduce the filtered positions for this first word entry and its attribute with each next word to those that are in order
				let filteredPositions = firstWordEntry.positions.slice()
				for (let i = 1; i < results.length; i++) {
					let entry = results[i].indexEntries.find(e => e.id === firstWordEntry.id
						&& e.attribute === firstWordEntry.attribute)
					if (entry) {
						filteredPositions = filteredPositions.filter(firstWordPosition => neverNull(entry)
							.positions
							.find(position => position === firstWordPosition + i))
					} else {
						// the id was probably not found for the same attribute as the current filtered positions, so we could not find all words in order in the same attribute
						filteredPositions = []
					}
				}
				return filteredPositions.length > 0
			})
		} else {
			// all ids must appear in all words now, so we can use any of the entries lists
			return results[0].indexEntries
		}
	}

	_reduceToUniqueElementIds(results: SearchIndexEntry[], previousResult: SearchResult): SearchIndexEntry[] {
		let uniqueIds = {}
		return results.filter(entry => {
			if (!uniqueIds[entry.id] && !previousResult.results.find(r => r[1] === entry.id)) {
				uniqueIds[entry.id] = true
				return true
			} else {
				return false
			}
		})
	}

	_filterByListIdAndGroupSearchResults(indexEntries: Array<MoreResultsIndexEntry>, searchResult: SearchResult,
	                                     maxResults: ?number): Promise<void> {
		indexEntries.sort((l, r) => compareNewestFirst(l.id, r.id))
		// We filter out everything we've processed from moreEntries, even if we didn't include it
		const {resolve: stop, promise: whenToStop} = defer()
		return this
			._db.dbFacade.createTransaction(true, [ElementDataOS])
			.then((transaction) =>
				Promise.race([
					whenToStop,
					Promise.map(indexEntries.slice(0, (maxResults || indexEntries.length + 1)), (entry, index) => {
						if (maxResults && searchResult.results.length >= maxResults) {
							stop()
							return
						}

						return transaction.get(ElementDataOS, uint8ArrayToBase64(entry.encId))
						                  .then((elementData: ?ElementDataDbRow) => {
							                  if (elementData
								                  && (!searchResult.restriction.listId
									                  || searchResult.restriction.listId === elementData[0])) {
								                  searchResult.results.push([elementData[0], entry.id])
							                  }
						                  })
					}, {concurrency: 5})
				]))
			.return()
	}

	getMoreSearchResults(searchResult: SearchResult, moreResultCount: number): Promise<void> {
		return this._startOrContinueSearch(searchResult, moreResultCount)
	}


	_getSearchEndTimestamp(restriction: SearchRestriction): number {
		if (restriction.end) {
			return restriction.end
		} else if (isSameTypeRef(MailTypeRef, restriction.type)) {
			return this._mailIndexer.currentIndexTimestamp === NOTHING_INDEXED_TIMESTAMP
				? Date.now() : this._mailIndexer.currentIndexTimestamp
		} else {
			return FULL_INDEXED_TIMESTAMP
		}
	}
}

const makeStamp = (name) => {
	timeEnd(name)
	timings[name] = getPerformanceTimestamp() - stamp
	stamp = getPerformanceTimestamp()
}
let stamp = getPerformanceTimestamp()
let timings = {}


