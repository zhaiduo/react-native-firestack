import firebase from 'firebase'
import db from 'firebase/database'
import invariant from 'invariant'

const createTypes = (prefix) => {
  const c = (str) => `${prefix.toUpperCase()}_${str.toUpperCase()}`
  return {
    ACTION_LISTEN: c('listen'),
    ACTION_UNLISTEN: c('unlisten'),
    ACTION_REMOVE: c('remove'),
    ACTION_UPDATE: c('update'),
    ACTION_SET: c('set'),
    ACTION_GET: c('get'),
    ITEM_VALUE: c('value'),
    ITEM_ADDED: c('added'),
    ITEM_REMOVED: c('remove'),
    ITEM_CHANGED: c('changed'),
    UPDATED: c('updated')
  }
}

const defaultToObject = child => ({_key: child.key, ...child.val()})
const identity = (i) => i
const defaultSortFn = (a, b) => a.timestamp < b.timestamp
const defaultInitialState = {
  items: [],
}

export class FirestackModule {
  constructor(refName, opts={}) {
    invariant(refName && typeof refName !== 'undefined', 'No ref name passed');
    
    this._refName = refName;
    this._makeRef = opts.makeRef || identity;
    let firestack = this._firestack = opts.firestack;

    const initialState = Object.assign({}, opts.initialState || defaultInitialState, {
      listening: false,
      items: []
    })

    this._localState = initialState;

    this._types = createTypes(this._refName);
    this._toObject = opts.toObject || defaultToObject
    this._sortFn = opts.sortFn || defaultSortFn
    this._onChange = opts.onChange || identity;

    this.setStore(opts.store);
  }

  makeRef(path) {
    const refName = [this._refName, path].join('/');
    return this._makeRef(this._firestack.database.ref(refName));
  }

  setStore(store) {
    if (store) {
      this._store = store;
    }
  }

  /*
   * Actions
   */
  listen(cb) {
    let store = this._getStore();
    invariant(store, 'Please set the store');

    const T = this._types;
    const listenRef = this.makeRef();
    const toObject = this._toObject;

    const _itemAdded = (snapshot, prevKey) => {
      const state = this._getState(); // local state
      const newItem = toObject(snapshot, state);
      let list = state.items || [];
      list.push(newItem)
      list = list.sort(this._sortFn)
      return this._handleUpdate(T.ITEM_ADDED, {items: list}, cb);
    }
    const _itemRemoved = (snapshot, prevKey) => {
      const state = this._getState(); // local state
      const itemKeys = state.items.map(i => i._key);
      const itemIndex = itemKeys.indexOf(snapshot.key);
      let newItems = [].concat(state.items);
      newItems.splice(itemIndex, 1);
      let list = newItems.sort(this._sortFn)
      return this._handleUpdate(T.ITEM_REMOVED, {items: list}, cb);
    }
    const _itemChanged = (snapshot, prevKey) => {
      const state = this._getState()
      const existingItem = toObject(snapshot, state);

      let list = state.items;
      let listIds = state.items.map(i => i.uid);
      const itemIdx = listIds.indexOf(existingItem.uid);
      list.splice(itemIdx, 1, existingItem);
      return this._handleUpdate(T.ITEM_CHANGED, {items: list}, cb);
    }

    return new Promise((resolve, reject) => {
      listenRef.on('child_added', _itemAdded);
      listenRef.on('child_removed', _itemRemoved);
      listenRef.on('child_changed', _itemChanged);

      this._handleUpdate(T.ACTION_LISTEN, null, (state) => {
        resolve(state)
      })
    })
  }

  unlisten() {
    const T = this._types;
    return new Promise((resolve, reject) => {
      this.firestack.off(this._ref);
      this._handleUpdate(T.ACTION_UNLISTEN, null, (state) => {
        resolve(state)
      })
    })
    return (dispatch, getState) => {
      const {firestack} = getState();
      firestack.off(this._ref);
      dispatch({type: this._types.ACTION_UNLISTEN})
    }
  }

  // TODO: Untested
  getAt(path, cb) {
    const T = this._types;
    const ref = this.makeRef(path);
    const toObject = this._toObject;

    return new Promise((resolve, reject) => {
      ref.once('value', snapshot => {
        this._handleUpdate(T.ACTION_GET, null, (state) => {
          if (cb) {
            cb(toObject(snapshot, state));
          }
          resolve(state)
        })
      }, reject);
    });
  }

  setAt(path, value, cb) {
    const T = this._types;
    const ref = this.makeRef(path);
    const toObject = this._toObject;

    return new Promise((resolve, reject) => {
      ref.set(value, error => {
        this._handleUpdate(T.ACTION_SET, null, (state) => {
          if (cb) {
            cb(toObject(snapshot, state));
          }
          return error ? reject(error) : resolve(value)
        });
      });
    });
  }

  updateAt(path, value, cb) {
    const T = this._types;
    const ref = this.makeRef(path);
    const toObject = this._toObject;

    return new Promise((resolve, reject) => {
      ref.update(value, error => {
        this._handleUpdate(T.ACTION_UPDATE, null, (state) => {
          if (cb) {
            cb(toObject(snapshot, state));
          }
          return error ? reject(error) : resolve(value)
        });
      });
    });
  }

  removeAt(path, cb) {
    const T = this._types;
    const ref = this.makeRef(path);
    const toObject = this._toObject;

    return new Promise((resolve, reject) => {
      ref.remove(value, error => {
        this._handleUpdate(T.ACTION_SET, null, (state) => {
          if (cb) {
            cb(toObject(snapshot, state));
          }
          return error ? reject(error) : resolve(value)
        });
      });
    });
  }

  // hackish, for now
  get actions() {
    return [
      'listen', 'unlisten',
      'get', 'set', 'update', 'remove'
    ].reduce((sum, name) => {
      return {
        ...sum,
        [name]: this[name].bind(this)
      }
    }, {})
  }

  get initialState() {
    return this._initialState;
  }

  get types() {
    return this._types
  }

  get reducer() {
    const T = this._types;
    return (state = this._localState, {type, payload, meta}) => {
      if (meta && meta.module && meta.module === this._refName) {
        switch (type) {
          case T.ACTION_LISTEN:
            return ({...state, listening: true});
          case T.ACTION_UNLISTEN:
            return ({...state, listening: false});
          default:
            return {...state, ...payload};
        }
      }
      return state;
    }
  }

  /**
   * Helpers
   **/

  _handleUpdate(type, newState = {}, cb = identity) {
    const store = this._getStore();
    if (store && store.dispatch && typeof store.dispatch === 'function') {
      store.dispatch({type, payload: newState, meta: { module: this._refName }})
    }
    return cb(newState);
  }

  _getStore() {
    return this._store ? 
            this._store : 
            (this._firestack ? this._firestack.store : null);
  }

  _getState() {
    const store = this._getStore();
    return store.getState()[this._refName];
  }

  _runCallback(dispatch, getState) {
    return (action) => {
      if (this._onChange && typeof this._onChange === 'function') {
        try {
          dispatch(action);
          return this._onChange(dispatch, getState)(action)
        } catch (e) {
          console.log('Error in callback', e);
        }
      }
      return newState;
    }
  }

}

export default FirestackModule
