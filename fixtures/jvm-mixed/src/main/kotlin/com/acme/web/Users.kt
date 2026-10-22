package com.acme.web

import com.acme.model.User
import com.acme.store.UserRepo

object Users {
    fun audit() {
        val repo = UserRepo()
        val user: User = repo.load("a")
        user.save()
        Report.make(user)
    }
}

class Report(private val user: User) {
    fun print(): String {
        return user.key()
    }
    companion object {
        fun make(user: User): Report {
            return Report(user)
        }
    }
}
