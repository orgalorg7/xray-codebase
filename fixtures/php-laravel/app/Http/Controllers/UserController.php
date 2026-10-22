<?php
namespace App\Http\Controllers;

use App\Repos\UserRepo;
use App\Models\{User, Keyed};

class UserController extends Controller
{
    public function __construct(private UserRepo $repo) { parent::__construct(); }

    public function show(string $id): User
    {
        $user = $this->repo->find($id);
        $user->save();
        self::log($user);
        User::query()->save();
        return $user;
    }

    private static function log(Keyed $k): void { $k->key(); }
}

class Controller { public function __construct() {} }
