<?php
namespace App\Repos;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use function App\Support\clean;

class UserRepo
{
    public function find(string $id): User { DB::table('users'); return new User(clean($id)); }
}
